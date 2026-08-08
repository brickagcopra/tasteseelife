import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { InvalidTokenError, type RequestContext, verifyAccessToken } from '@taste-and-see/auth-sdk';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

import { ENV_TOKEN } from '../config/config.module';
import { parseCorsOrigins, type Env } from '../config/env';
import { roomForThread, roomForUser } from './realtime-rooms';
import type { ThreadParticipantRole } from './thread-posting-policy';
import {
  ThreadMembershipService,
  type ResolvedMembership,
} from './services/thread-membership.service';

/**
 * Per-socket state attached at handshake-time. Lives on
 * `socket.data` (which Socket.IO documents as the per-connection
 * scratchpad). The userId + roles drive every authorization decision
 * after the handshake — the gateway never re-reads the JWT.
 */
export interface SocketData {
  readonly requestContext: RequestContext;
}

/** Zod schema for the inbound `thread:join` / `thread:leave` payload. */
const ThreadIdPayloadSchema = z
  .object({
    threadId: z.string().min(1).max(100),
  })
  .strict();
type ThreadIdPayload = z.infer<typeof ThreadIdPayloadSchema>;

/** ACK envelope clients receive after a `thread:join` / `thread:leave`. */
export interface AckResponse {
  readonly ok: boolean;
  /**
   * The joiner's participant role, echoed so the client can render the
   * right affordances (a read-only `observer` hides the composer; a
   * peer-thread `moderator` shows moderation controls — TS-209). Posting
   * itself is gated server-side by `thread-posting-policy`, never by the
   * client honouring this hint.
   */
  readonly role?: ThreadParticipantRole;
  readonly error?: 'invalid_payload' | 'not_a_participant' | 'thread_archived';
}

/**
 * The Socket.IO gateway for service-messaging.
 *
 * **Handshake auth.** Token comes from `socket.handshake.auth.token`
 * (the browser SDK's `io(url, { auth: { token } })` slot — survives
 * the polling-to-websocket upgrade without a custom header). Fallback
 * to `Authorization: Bearer <jwt>` for non-browser callers. Failure
 * disconnects the socket immediately; the client receives a
 * `connect_error` with a generic message (no leakage of which failure
 * mode occurred). Matches the access-token guard contract in
 * service-identity.
 *
 * **Room model.**
 *   - Every connected socket automatically joins `user:<userId>` so
 *     the broadcaster can fan out per-user events (notifications,
 *     thread-updated nudges).
 *   - Per-thread rooms (`thread:<threadId>`) are explicitly joined via
 *     the `thread:join` handler after a participant-row check
 *     against Postgres. Every participant role shares the same room
 *     regardless of thread kind; *who may post* is a publish-time
 *     decision made by the pure `thread-posting-policy` matrix on
 *     `(thread kind, participant role)` — read-only observers, and
 *     the provider-community `peer_thread` rules (providers +
 *     moderators post, observers read-only, concierge has no standing)
 *     per PRD §7.7 / TS-209. That gate lands with the future
 *     `message:send` handler (TS-209-followup-3, blocked on the
 *     Cassandra body store TS-070-followup-1); today TS-071 ships
 *     read-only delivery so all roles are indistinguishable on the
 *     wire.
 *
 * **Multi-pod fan-out.** The Redis adapter installed in `main.ts`
 * propagates every `server.to(room).emit(...)` call across every pod
 * in the deployment. From a handler's perspective the call is just
 * Socket.IO — the adapter is transparent.
 *
 * **Why a single namespace?** Phase-1 has one realtime surface, so
 * the root namespace (`/`) is sufficient. A future Tier-3 concierge
 * surface or a separate provider-only namespace can land as
 * additional `@WebSocketGateway({ namespace: '/concierge' })`
 * decorators on sibling gateway classes — none of the wiring in this
 * file changes.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The
 * `TenantContextInterceptor` only fires for HTTP requests — see the
 * `context.getType() !== 'http'` short-circuit in
 * `packages/nest-prisma-tenant-scope/src/interceptor/tenant-context.interceptor.ts`.
 * Each `@SubscribeMessage` handler that touches Prisma therefore wraps
 * its body in `this.tenantStore.runWith(socket.data.requestContext, ...)`
 * to seed the AsyncLocalStorage frame manually. The user IS authenticated
 * (the handshake verified the JWT and stored the resulting
 * `RequestContext` on `socket.data`), so the seeded frame is `scoped` —
 * NOT `exempt`. An `exempt` frame would be misleading in audit logs.
 *
 * Today only `thread:join` touches Prisma (via
 * `ThreadMembershipService.resolveMembership`); `thread:leave` is a
 * pure Socket.IO room-leave with no DB hop, so no wrap is needed there.
 * A future `message:send` handler that touches Prisma must follow the
 * same pattern.
 */
@Injectable()
@WebSocketGateway({
  // `path` and `cors` are read at gateway-construction time. The
  // gateway is registered as `@Injectable()` so Nest's DI resolves
  // `Env` via the constructor; the static decorator options below are
  // overridden in `RealtimeModule` via `useFactory` once Nest 11
  // exposes a clean override path. For TS-071 we set them via
  // environment in the IoAdapter (main.ts) and keep the decorator
  // options for fallback discoverability — see RedisIoAdapter.
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly membership: ThreadMembershipService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * Exposes the underlying `Server` instance via DI so the broadcaster
   * can call `server.to(room).emit(...)` without a circular import.
   * Registered in `RealtimeModule` via a `useFactory` that pulls the
   * server through `gateway.getServer()` after `onModuleInit`.
   */
  getServer(): Server {
    return this.server;
  }

  onModuleInit(): void {
    // Sanity log so a misconfigured CORS allowlist surfaces in the
    // boot trace rather than as a silent connection-refused on the
    // browser side.
    const origins = parseCorsOrigins(this.env.WS_CORS_ORIGINS);
    this.logger.log(
      {
        wsPath: this.env.WS_PATH,
        corsOrigins: origins.length === 0 ? 'server-to-server-only' : origins,
      },
      'realtime gateway ready',
    );
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = extractHandshakeToken(client);
    if (token === null) {
      this.logger.warn({ sid: client.id, reason: 'missing_token' }, 'realtime handshake rejected');
      client.disconnect(true);
      return;
    }

    let ctx: RequestContext;
    try {
      ctx = verifyAccessToken(token, {
        secret: this.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
        audience: this.env.JWT_AUDIENCE,
        issuer: this.env.JWT_ISSUER,
      });
    } catch (err) {
      const reason = err instanceof InvalidTokenError ? 'invalid_token' : 'verify_error';
      this.logger.warn({ sid: client.id, reason }, 'realtime handshake rejected');
      client.disconnect(true);
      return;
    }

    // Attach the context to socket.data for downstream handlers.
    client.data = { requestContext: ctx } satisfies SocketData;
    await client.join(roomForUser(ctx.userId));
    this.logger.log({ sid: client.id, userId: ctx.userId }, 'realtime client connected');
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as Partial<SocketData> | undefined;
    const userId = data?.requestContext?.userId;
    this.logger.log({ sid: client.id, userId }, 'realtime client disconnected');
  }

  @SubscribeMessage('thread:join')
  async handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse> {
    const ctx = readRequestContext(client);
    if (ctx === null) {
      return { ok: false, error: 'invalid_payload' };
    }
    const userId = ctx.userId;

    const parsed = ThreadIdPayloadSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(
        { sid: client.id, userId, reason: 'invalid_payload' },
        'thread:join rejected',
      );
      return { ok: false, error: 'invalid_payload' };
    }
    const payload: ThreadIdPayload = parsed.data;

    // Seed the tenant-scope frame for the lifetime of the handler. The
    // `TenantContextInterceptor` does not fire for WebSocket handlers
    // (it short-circuits on `context.getType() !== 'http'`), so the
    // gate would reject the Prisma read in `resolveMembership` with
    // `MissingRequestContextError` under the `enforce` posture. We
    // seed a `scoped` frame from the verified handshake context — NOT
    // `exempt`, because the user IS authenticated; an exempt frame
    // would be misleading in audit logs. The wrap encloses both the
    // Prisma read AND the room-join + ack so any future async hop
    // inside the handler body inherits the frame.
    return this.tenantStore.runWith(ctx, async () => {
      const membership = await this.membership.resolveMembership(payload.threadId, userId);
      const denial = denyMembershipReason(membership);
      if (denial !== null) {
        this.logger.warn(
          { sid: client.id, userId, threadId: payload.threadId, reason: denial },
          'thread:join rejected',
        );
        return { ok: false, error: denial };
      }

      // Non-null narrowed by denyMembershipReason returning null only
      // when membership is present and the thread is active.
      const resolved = membership as ResolvedMembership;
      await client.join(roomForThread(payload.threadId));
      this.logger.log(
        { sid: client.id, userId, threadId: payload.threadId, role: resolved.role },
        'thread:join accepted',
      );
      return { ok: true, role: resolved.role };
    });
  }

  @SubscribeMessage('thread:leave')
  async handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<AckResponse> {
    const userId = readUserId(client);
    if (userId === null) {
      return { ok: false, error: 'invalid_payload' };
    }
    const parsed = ThreadIdPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'invalid_payload' };
    }
    await client.leave(roomForThread(parsed.data.threadId));
    this.logger.log(
      { sid: client.id, userId, threadId: parsed.data.threadId },
      'thread:leave accepted',
    );
    return { ok: true };
  }
}

/**
 * Token extraction follows the Socket.IO conventions:
 *   1. `socket.handshake.auth.token` — preferred for browser clients
 *      (the SDK's `io(url, { auth: { token } })` slot survives the
 *      polling-to-websocket upgrade).
 *   2. `Authorization: Bearer <token>` — fallback for server-to-server
 *      callers using plain WebSockets without the JS SDK.
 *
 * Returns null on every missing / malformed / non-string case so the
 * handler can issue a single generic reject path.
 */
function extractHandshakeToken(client: Socket): string | null {
  const auth = client.handshake.auth as { readonly token?: unknown } | undefined;
  if (auth && typeof auth.token === 'string' && auth.token.length > 0) {
    return auth.token;
  }
  const headerValue = client.handshake.headers.authorization;
  if (typeof headerValue === 'string') {
    const trimmed = headerValue.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      const token = trimmed.slice(7).trim();
      return token.length > 0 ? token : null;
    }
  }
  return null;
}

function readUserId(client: Socket): string | null {
  const data = client.data as Partial<SocketData> | undefined;
  if (data?.requestContext?.userId !== undefined && data.requestContext.userId.length > 0) {
    return data.requestContext.userId;
  }
  return null;
}

/**
 * Returns the full `RequestContext` stored on `socket.data` at handshake
 * time, or null if the socket is mid-handshake / unauthenticated.
 * Handlers that need to seed the tenant-scope AsyncLocalStorage frame
 * (TS-020-followup-2b-platform-rollout) read the full context here
 * rather than just the userId because the frame carries roles +
 * tenantScope + mfaVerified that downstream gate decisions may consult.
 */
function readRequestContext(client: Socket): RequestContext | null {
  const data = client.data as Partial<SocketData> | undefined;
  const ctx = data?.requestContext;
  if (ctx === undefined || typeof ctx.userId !== 'string' || ctx.userId.length === 0) {
    return null;
  }
  return ctx;
}

/**
 * Maps a resolved membership to the join-denial reason (or null if
 * the join should proceed). Pure function for ease of testing.
 */
export function denyMembershipReason(
  membership: ResolvedMembership | null,
): 'not_a_participant' | 'thread_archived' | null {
  if (membership === null) return 'not_a_participant';
  if (membership.threadArchivedAt !== null) return 'thread_archived';
  return null;
}
