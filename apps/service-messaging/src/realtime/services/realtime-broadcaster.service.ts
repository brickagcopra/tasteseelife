import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

import { roomForThread, roomForUser } from '../realtime-rooms';
import { RealtimeGateway } from '../realtime.gateway';

/**
 * The set of platform events the realtime layer fans out today.
 *
 * **Why a closed union and not free-form?** Every consumer (browser,
 * provider portal, ops dashboard) needs a stable contract. Add an
 * event by extending the union here AND in the gateway-side allowlist
 * (or the SDK published to consumers) — never let an upstream caller
 * invent an event name on the wire (CLAUDE.md §5.3 "backward-compatible
 * evolution: add fields, never repurpose").
 *
 * Today's events:
 *   - `message.created`     — a new message landed in a thread. Payload
 *                             carries the message id + sender id only;
 *                             body fetch goes via Cassandra
 *                             (TS-070-followup-1) to keep PII off the
 *                             realtime channel.
 *   - `thread.updated`      — metadata flip (rename, archive,
 *                             participants changed). Triggers a UI
 *                             refresh.
 *   - `participant.joined`  — a participant row appeared on the thread.
 *   - `participant.left`    — a participant row disappeared (soft-leave
 *                             column lands in a TS-070-followup).
 */
export type RealtimeEvent =
  | 'message.created'
  | 'thread.updated'
  | 'participant.joined'
  | 'participant.left';

/**
 * Fans out platform events to the appropriate Socket.IO rooms.
 *
 * Two emit surfaces:
 *
 *   - `emitToThread(threadId, event, payload)` — broadcast to every
 *     connected participant of the thread. Each room is
 *     `thread:<threadId>`. Membership in the room is gated by the
 *     gateway's `thread:join` handler — only authenticated
 *     participants are ever in the room, so a leaked event from this
 *     surface still respects the row-level membership gate.
 *
 *   - `emitToUser(userId, event, payload)` — broadcast to every
 *     connection a single user has open across all pods (room
 *     `user:<userId>`). Used for notifications-style fan-out: "you
 *     have a new message in some thread you're not currently looking
 *     at." Lands when TS-073's in-app channel adapter starts
 *     publishing through this broadcaster (TS-073-followup-4).
 *
 * Multi-pod fan-out is transparent to the caller — the underlying
 * `server.to(room).emit(...)` call goes through the Redis adapter
 * configured in `main.ts`. A caller on pod A reaches a browser on
 * pod B without any extra plumbing.
 *
 * **Best-effort delivery.** Socket.IO does not durably store messages
 * for an offline client; a browser that reconnects after a network
 * blip will miss anything broadcast while it was disconnected.
 * Durability for the message body lives in Cassandra
 * (TS-070-followup-1); the realtime layer is the "live tap" on top.
 *
 * **Server-instance resolution.** The underlying `Server` is owned by
 * the gateway (its `@WebSocketServer()` field is populated by Nest at
 * runtime). The broadcaster reaches the server through
 * `gateway.getServer()` per call — cheap (a field read) and avoids a
 * lifecycle-order coupling between provider instantiation and the
 * `@WebSocketServer()` decorator's runtime injection.
 */
@Injectable()
export class RealtimeBroadcaster {
  private readonly logger = new Logger(RealtimeBroadcaster.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  emitToThread(threadId: string, event: RealtimeEvent, payload: unknown): void {
    const room = roomForThread(threadId);
    const server = this.requireServer();
    server.to(room).emit(event, payload);
    this.logger.debug({ event, room }, 'realtime broadcast to thread');
  }

  emitToUser(userId: string, event: RealtimeEvent, payload: unknown): void {
    const room = roomForUser(userId);
    const server = this.requireServer();
    server.to(room).emit(event, payload);
    this.logger.debug({ event, room }, 'realtime broadcast to user');
  }

  private requireServer(): Server {
    const server = this.gateway.getServer();
    if (server === undefined) {
      // The `@WebSocketServer()` field is set during Nest's
      // gateway-init phase, which finishes well before any HTTP
      // request lands. Reaching this branch means the broadcaster
      // was invoked from a module-init hook or a unit test that did
      // not stub the gateway — a programming error.
      throw new Error('RealtimeBroadcaster invoked before the Socket.IO server was initialised');
    }
    return server;
  }
}
