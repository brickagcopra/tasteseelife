import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';
import { RealtimeGateway, denyMembershipReason } from './realtime.gateway';
import type {
  ResolvedMembership,
  ThreadMembershipService,
} from './services/thread-membership.service';

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    NODE_ENV: 'test',
    PORT: 3017,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    REDIS_URL: 'redis://localhost:6379',
    REDIS_KEY_NAMESPACE_PREFIX: 'test:service-messaging:socket:',
    WS_PATH: '/socket.io',
    WS_CORS_ORIGINS: '',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
  } as const;
  return { ...base, ...overrides } as Env;
}

function signToken(env: Env, sub = 'usr_1'): string {
  return jwt.sign(
    {
      sub,
      sid: 'fam_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: 900,
    },
  );
}

interface SocketStub {
  socket: Socket;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSocket(authToken: string | null, headerToken: string | null = null): SocketStub {
  const join = vi.fn(async (_room: string) => {});
  const leave = vi.fn(async (_room: string) => {});
  const disconnect = vi.fn();
  const auth: { token?: string } = {};
  if (authToken !== null) auth.token = authToken;
  const headers: { authorization?: string } = {};
  if (headerToken !== null) headers.authorization = `Bearer ${headerToken}`;
  const socket = {
    id: 'sid_1',
    data: undefined,
    handshake: { auth, headers },
    join,
    leave,
    disconnect,
  } as unknown as Socket;
  return { socket, join, leave, disconnect };
}

function makeMembershipStub(result: ResolvedMembership | null): ThreadMembershipService {
  return {
    resolveMembership: vi.fn(async () => result),
  } as unknown as ThreadMembershipService;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function makeGateway(
  env: Env,
  membership: ThreadMembershipService,
  store: TenantContextStore = makeStore(),
): RealtimeGateway {
  // The @WebSocketServer() field is unused for the connection / message
  // handler paths we exercise in these tests — we never call
  // `getServer()` from here. The gateway's interaction with the server
  // is limited to setting up rooms on the socket itself.
  return new RealtimeGateway(env, membership, store);
}

describe('RealtimeGateway.handleConnection', () => {
  it('accepts a valid token from socket.handshake.auth.token and joins the per-user room', async () => {
    const env = makeEnv();
    const token = signToken(env, 'usr_42');
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join, disconnect } = makeSocket(token);
    await gateway.handleConnection(socket);
    expect(disconnect).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith('user:usr_42');
    const data = socket.data as { requestContext?: { userId: string } } | undefined;
    expect(data?.requestContext?.userId).toBe('usr_42');
  });

  it('accepts a valid token from the Authorization Bearer header', async () => {
    const env = makeEnv();
    const token = signToken(env, 'usr_43');
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join, disconnect } = makeSocket(null, token);
    await gateway.handleConnection(socket);
    expect(disconnect).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith('user:usr_43');
  });

  it('disconnects when no token is presented', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join, disconnect } = makeSocket(null);
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
    expect(join).not.toHaveBeenCalled();
  });

  it('disconnects on a token signed with the wrong secret', async () => {
    const env = makeEnv();
    const bad = jwt.sign(
      { sub: 'usr_x', roles: [], tenantScope: { type: 'global' } },
      'b'.repeat(32),
      {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: 900,
      },
    );
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, disconnect } = makeSocket(bad);
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects on a token with the wrong issuer', async () => {
    const env = makeEnv();
    const bad = jwt.sign(
      { sub: 'usr_x', roles: [], tenantScope: { type: 'global' } },
      env.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        issuer: 'someone-else',
        audience: env.JWT_AUDIENCE,
        expiresIn: 900,
      },
    );
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, disconnect } = makeSocket(bad);
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects on an expired token', async () => {
    const env = makeEnv();
    const expired = jwt.sign(
      { sub: 'usr_x', roles: [], tenantScope: { type: 'global' } },
      env.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: -1,
      },
    );
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, disconnect } = makeSocket(expired);
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('ignores an Authorization header with a non-Bearer scheme', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, disconnect } = makeSocket(null);
    // Manually splice a Basic header — no Bearer means no token.
    socket.handshake.headers.authorization = 'Basic abcdef';
    await gateway.handleConnection(socket);
    expect(disconnect).toHaveBeenCalledWith(true);
  });
});

describe('RealtimeGateway.handleJoinThread', () => {
  it('joins the thread room when the user is a participant on an active thread', async () => {
    const env = makeEnv();
    const membership = makeMembershipStub({
      threadId: 'thr_1',
      userId: 'usr_1',
      kind: 'household',
      role: 'member',
      threadArchivedAt: null,
    });
    const gateway = makeGateway(env, membership);
    const { socket, join } = makeSocket(signToken(env, 'usr_1'));
    await gateway.handleConnection(socket);
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_1' });
    expect(ack).toEqual({ ok: true, role: 'member' });
    expect(join).toHaveBeenCalledWith('thread:thr_1');
  });

  it('joins a peer_thread and echoes the moderator role on the ack (TS-209)', async () => {
    const env = makeEnv();
    const membership = makeMembershipStub({
      threadId: 'thr_peer',
      userId: 'usr_mod',
      kind: 'peer_thread',
      role: 'moderator',
      threadArchivedAt: null,
    });
    const gateway = makeGateway(env, membership);
    const { socket, join } = makeSocket(signToken(env, 'usr_mod'));
    await gateway.handleConnection(socket);
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_peer' });
    expect(ack).toEqual({ ok: true, role: 'moderator' });
    expect(join).toHaveBeenCalledWith('thread:thr_peer');
  });

  it('rejects when the user is not a participant', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join } = makeSocket(signToken(env, 'usr_2'));
    await gateway.handleConnection(socket);
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_x' });
    expect(ack).toEqual({ ok: false, error: 'not_a_participant' });
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects when the thread is archived', async () => {
    const env = makeEnv();
    const membership = makeMembershipStub({
      threadId: 'thr_z',
      userId: 'usr_3',
      kind: 'booking',
      role: 'observer',
      threadArchivedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const gateway = makeGateway(env, membership);
    const { socket, join } = makeSocket(signToken(env, 'usr_3'));
    await gateway.handleConnection(socket);
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_z' });
    expect(ack).toEqual({ ok: false, error: 'thread_archived' });
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload shape', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join } = makeSocket(signToken(env));
    await gateway.handleConnection(socket);
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 42 });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
    expect(join).not.toHaveBeenCalled();
  });

  it('rejects when socket.data is missing a requestContext (defensive — handshake should have set it)', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, join } = makeSocket(signToken(env));
    // Deliberately do NOT call handleConnection; socket.data stays undefined.
    join.mockClear();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_1' });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('accepts observer role and returns it on the ack', async () => {
    const env = makeEnv();
    const membership = makeMembershipStub({
      threadId: 'thr_o',
      userId: 'usr_o',
      kind: 'household',
      role: 'observer',
      threadArchivedAt: null,
    });
    const gateway = makeGateway(env, membership);
    const { socket } = makeSocket(signToken(env, 'usr_o'));
    await gateway.handleConnection(socket);
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_o' });
    expect(ack).toEqual({ ok: true, role: 'observer' });
  });
});

describe('RealtimeGateway tenant-scope scoped wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds a scoped frame matching the handshake context for the lifetime of the Prisma read', async () => {
    const env = makeEnv();
    const store = makeStore();
    const observed: Array<unknown> = [];
    const membership = {
      resolveMembership: vi.fn(async (): Promise<ResolvedMembership | null> => {
        observed.push(store.current());
        return {
          threadId: 'thr_w',
          userId: 'usr_w',
          kind: 'household',
          role: 'member',
          threadArchivedAt: null,
        };
      }),
    } as unknown as ThreadMembershipService;
    const gateway = makeGateway(env, membership, store);
    const { socket } = makeSocket(signToken(env, 'usr_w'));
    await gateway.handleConnection(socket);
    expect(store.current()).toBeNull();
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_w' });
    expect(ack).toEqual({ ok: true, role: 'member' });
    // The Prisma collaborator ran inside the wrap — the captured frame
    // is `scoped` and carries the handshake's userId.
    expect(observed).toHaveLength(1);
    const frame = observed[0];
    expect(frame).toMatchObject({
      kind: 'scoped',
      context: { userId: 'usr_w' },
    });
    // The frame is released after the handler resolves — no leak.
    expect(store.current()).toBeNull();
  });

  it('does NOT seed a frame when the payload is invalid (handler short-circuits before the wrap)', async () => {
    const env = makeEnv();
    const store = makeStore();
    const resolveMembership = vi.fn(async () => null);
    const membership = { resolveMembership } as unknown as ThreadMembershipService;
    const gateway = makeGateway(env, membership, store);
    const { socket } = makeSocket(signToken(env, 'usr_q'));
    await gateway.handleConnection(socket);
    const ack = await gateway.handleJoinThread(socket, { threadId: 42 });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
    // The Prisma collaborator never fired — no frame was ever needed.
    expect(resolveMembership).not.toHaveBeenCalled();
    expect(store.current()).toBeNull();
  });

  it('does NOT seed a frame when socket.data lacks a requestContext (mid-handshake reject)', async () => {
    const env = makeEnv();
    const store = makeStore();
    const resolveMembership = vi.fn(async () => null);
    const membership = { resolveMembership } as unknown as ThreadMembershipService;
    const gateway = makeGateway(env, membership, store);
    const { socket } = makeSocket(signToken(env));
    // Deliberately do NOT call handleConnection; socket.data stays undefined.
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_w' });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
    expect(resolveMembership).not.toHaveBeenCalled();
    expect(store.current()).toBeNull();
  });

  it('releases the frame even when the Prisma read returns null (membership denial path)', async () => {
    const env = makeEnv();
    const store = makeStore();
    const observed: Array<unknown> = [];
    const membership = {
      resolveMembership: vi.fn(async (): Promise<ResolvedMembership | null> => {
        observed.push(store.current());
        return null;
      }),
    } as unknown as ThreadMembershipService;
    const gateway = makeGateway(env, membership, store);
    const { socket } = makeSocket(signToken(env, 'usr_r'));
    await gateway.handleConnection(socket);
    const ack = await gateway.handleJoinThread(socket, { threadId: 'thr_r' });
    expect(ack).toEqual({ ok: false, error: 'not_a_participant' });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'scoped', context: { userId: 'usr_r' } });
    expect(store.current()).toBeNull();
  });
});

describe('RealtimeGateway.handleLeaveThread', () => {
  it('leaves the thread room on a valid payload', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, leave } = makeSocket(signToken(env));
    await gateway.handleConnection(socket);
    const ack = await gateway.handleLeaveThread(socket, { threadId: 'thr_1' });
    expect(ack).toEqual({ ok: true });
    expect(leave).toHaveBeenCalledWith('thread:thr_1');
  });

  it('rejects when socket.data has no requestContext', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, leave } = makeSocket(signToken(env));
    const ack = await gateway.handleLeaveThread(socket, { threadId: 'thr_1' });
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
    expect(leave).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket, leave } = makeSocket(signToken(env));
    await gateway.handleConnection(socket);
    const ack = await gateway.handleLeaveThread(socket, null);
    expect(ack).toEqual({ ok: false, error: 'invalid_payload' });
    expect(leave).not.toHaveBeenCalled();
  });
});

describe('denyMembershipReason (pure)', () => {
  it('returns not_a_participant when membership is null', () => {
    expect(denyMembershipReason(null)).toBe('not_a_participant');
  });

  it('returns thread_archived when the thread is archived', () => {
    expect(
      denyMembershipReason({
        threadId: 'thr_1',
        userId: 'usr_1',
        kind: 'booking',
        role: 'member',
        threadArchivedAt: new Date(),
      }),
    ).toBe('thread_archived');
  });

  it('returns null when the membership row is active', () => {
    expect(
      denyMembershipReason({
        threadId: 'thr_1',
        userId: 'usr_1',
        kind: 'household',
        role: 'member',
        threadArchivedAt: null,
      }),
    ).toBeNull();
  });
});

describe('RealtimeGateway.handleDisconnect', () => {
  it('does not throw when socket.data is missing (mid-handshake disconnect)', () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket } = makeSocket(null);
    expect(() => gateway.handleDisconnect(socket)).not.toThrow();
  });

  it('extracts userId from socket.data when present', async () => {
    const env = makeEnv();
    const gateway = makeGateway(env, makeMembershipStub(null));
    const { socket } = makeSocket(signToken(env, 'usr_q'));
    await gateway.handleConnection(socket);
    expect(() => gateway.handleDisconnect(socket)).not.toThrow();
  });
});

describe('RealtimeGateway.getServer + onModuleInit', () => {
  it('exposes the (uninitialised) server reference and onModuleInit does not throw', () => {
    const env = makeEnv({ WS_CORS_ORIGINS: 'https://app.example.com' });
    const gateway = makeGateway(env, makeMembershipStub(null));
    expect(() => gateway.onModuleInit()).not.toThrow();
    // Server is set by @WebSocketServer() at runtime; in unit tests the
    // decorator does not fire, so getServer() returns undefined. The
    // contract guaranteed by the gateway is that the field exists and
    // is the one the broadcaster wires through in production.
    expect(gateway.getServer()).toBeUndefined();
  });
});
