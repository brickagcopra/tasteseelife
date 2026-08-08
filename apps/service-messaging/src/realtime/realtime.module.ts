import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeBroadcaster } from './services/realtime-broadcaster.service';
import { ThreadMembershipService } from './services/thread-membership.service';

/**
 * Wires the realtime delivery surface for service-messaging (PDD
 * §13.1).
 *
 * Composition:
 *
 *   - `RealtimeGateway`         — the Socket.IO `@WebSocketGateway`.
 *                                 Owns the `Server` instance via the
 *                                 `@WebSocketServer()` decorator.
 *                                 Handles handshake auth + per-thread
 *                                 room joins.
 *   - `ThreadMembershipService` — Prisma-backed participant lookup
 *                                 the gateway uses to gate `thread:join`.
 *   - `RealtimeBroadcaster`     — public emit surface for in-process
 *                                 producers (the future HTTP message
 *                                 create, the outbox-relay consumer,
 *                                 the in-app notification dispatcher).
 *                                 Reaches the gateway's server via a
 *                                 forwardRef-injected gateway
 *                                 reference, sidestepping the
 *                                 import-time cycle that would
 *                                 otherwise form between gateway and
 *                                 broadcaster.
 *
 * The Redis adapter (`RedisIoAdapter`) is installed at the
 * application level in `main.ts` via `app.useWebSocketAdapter(...)`
 * because the adapter holds Redis client state that has nothing to do
 * with Nest's module lifecycle.
 */
@Module({
  imports: [PrismaModule],
  providers: [ThreadMembershipService, RealtimeGateway, RealtimeBroadcaster],
  exports: [RealtimeBroadcaster, RealtimeGateway],
})
export class RealtimeModule {}
