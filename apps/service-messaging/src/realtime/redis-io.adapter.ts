import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { ServerOptions, Server } from 'socket.io';

import type { Env } from '../config/env';
import { parseCorsOrigins } from '../config/env';

/**
 * NestJS WebSocket adapter that wires Socket.IO to a Redis pub/sub
 * backplane.
 *
 * Multi-pod fan-out works as follows: each pod boots its own
 * Socket.IO `Server` and joins a shared Redis channel; whenever a
 * handler calls `server.to(room).emit(event, payload)`, the adapter
 * publishes the (room, event, payload) tuple to Redis, every other pod
 * receives the publish and emits to its local sockets in the same
 * room. Without the adapter, a browser on pod A would never see a
 * message produced by pod B.
 *
 * **Connection-level resilience.** The two ioredis clients (pub +
 * sub) wire `enableOfflineQueue: false` + `maxRetriesPerRequest: 1`.
 * A transient Redis outage *after boot* degrades the realtime layer to
 * "single-pod delivery" instead of buffering writes and stalling the
 * request path (CLAUDE.md §4.3 "caches are best-effort"). The
 * underlying socket still delivers locally; cross-pod fan-out
 * resumes once Redis recovers, because ioredis reconnects and the
 * adapter re-subscribes on the same clients.
 *
 * **Boot is deliberately not best-effort.** A pod that comes up
 * without the backplane never acquires one: `server.adapter(...)` is
 * called once, in `createIOServer`, so degrading at startup would
 * leave *this pod* permanently unable to see messages from any other
 * — silently, and for the whole life of the pod. So `connectToRedis`
 * fails the bootstrap instead, and the pod is restarted until Redis is
 * reachable. That is the opposite of the runtime posture above, and
 * the asymmetry is the point: a transient outage is survivable, an
 * absent backplane at startup is not.
 *
 * **Key namespacing.** The adapter accepts a `key` option that
 * prefixes every Redis channel name. We pin it to
 * `{env}:service-messaging:socket:` via `REDIS_KEY_NAMESPACE_PREFIX`
 * (CLAUDE.md §3.7 "No flat keys").
 *
 * **CORS.** The Socket.IO server-options `cors` slot is set here from
 * the parsed `WS_CORS_ORIGINS` allowlist. We never pass `cors:
 * { origin: '*' }` — wildcards with credentials are the OWASP CORS
 * misconfig.
 */
/**
 * Upper bound on the initial pub/sub handshake. Stated explicitly
 * rather than left to ioredis's default so the boot-failure deadline is
 * visible at the call site (CLAUDE.md §5.2 "no infinite waits").
 */
const REDIS_CONNECT_TIMEOUT_MS = 10_000;

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterFactory: ReturnType<typeof createAdapter> | undefined = undefined;
  private pubClient: Redis | undefined = undefined;
  private subClient: Redis | undefined = undefined;

  constructor(
    app: INestApplicationContext,
    private readonly env: Env,
  ) {
    super(app);
  }

  /**
   * Open the publisher + subscriber ioredis clients and build the
   * Socket.IO adapter factory. Called once at bootstrap from
   * `main.ts` before `app.listen(...)`.
   *
   * **Ordering is load-bearing (TS-507).** `createAdapter` issues a
   * `psubscribe` from its own constructor. These clients set
   * `enableOfflineQueue: false` — deliberately, so a wedged Redis fails
   * fast rather than silently queueing writes — which means a command
   * issued before the socket is writable cannot be buffered and ioredis
   * throws *synchronously*: "Stream isn't writeable and
   * enableOfflineQueue options is false". Handing freshly-constructed
   * clients straight to `createAdapter` therefore killed the process
   * during `NestFactory` bootstrap, and a healthy, reachable Redis did
   * not help — it is a startup-ordering fault, not a connectivity one.
   *
   * So both clients are constructed with `lazyConnect: true` and
   * explicitly awaited to `ready` before the adapter is built. The
   * offline-queue setting is untouched.
   *
   * If either client cannot connect, this rejects and the bootstrap
   * fails — see the class doc-block for why startup is not best-effort.
   * The wait is bounded by ioredis's `connectTimeout`: a refused
   * connection rejects immediately, an unroutable host after the
   * timeout. Neither hangs.
   */
  async connectToRedis(): Promise<void> {
    const pub = new Redis(this.env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    });
    const sub = pub.duplicate();

    // Attached before `connect()` so a failure during the initial
    // handshake is logged rather than surfacing as an unhandled
    // 'error' event, and so post-boot reconnect noise stays at warn.
    pub.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'redis pub client error');
    });
    sub.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'redis sub client error');
    });

    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (err) {
      // Release both sockets before propagating: a half-open pair
      // would otherwise keep retrying behind a bootstrap that has
      // already failed.
      pub.disconnect();
      sub.disconnect();
      throw new Error(
        `realtime redis backplane unavailable at bootstrap: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Both clients are 'ready' here, so the adapter's psubscribe has a
    // writable stream and cannot hit the offline-queue throw.
    this.adapterFactory = createAdapter(pub, sub, {
      key: this.env.REDIS_KEY_NAMESPACE_PREFIX,
    });
    this.pubClient = pub;
    this.subClient = sub;
    this.logger.log(
      { keyPrefix: this.env.REDIS_KEY_NAMESPACE_PREFIX },
      'realtime redis adapter connected',
    );
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const origins = parseCorsOrigins(this.env.WS_CORS_ORIGINS);
    const cors =
      origins.length === 0
        ? // Server-to-server-only — refuse browser-origin handshakes.
          { origin: false as const, credentials: false }
        : { origin: [...origins], credentials: true };

    const merged: ServerOptions = {
      ...(options ?? ({} as ServerOptions)),
      path: this.env.WS_PATH,
      cors,
      transports: ['websocket', 'polling'],
    };

    // The IoAdapter base returns a `socket.io` `Server`; the @types
    // typing is loose so we narrow once at the boundary.
    const server = super.createIOServer(port, merged) as Server;
    if (this.adapterFactory !== undefined) {
      server.adapter(this.adapterFactory);
    } else {
      this.logger.warn(
        'realtime adapter created without redis backplane — connectToRedis() was not awaited',
      );
    }
    return server;
  }

  /**
   * Close the publisher + subscriber clients. Wired to NestJS's
   * shutdown hook in `main.ts` so a SIGTERM cleanly drains the
   * pub/sub channels before the pod exits.
   */
  async disconnectFromRedis(): Promise<void> {
    const pub = this.pubClient;
    if (pub !== undefined) {
      pub.disconnect();
      this.pubClient = undefined;
    }
    const sub = this.subClient;
    if (sub !== undefined) {
      sub.disconnect();
      this.subClient = undefined;
    }
  }
}
