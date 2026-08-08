import { Module } from '@nestjs/common';

import { ThreadsController } from './controllers/threads.controller';
import { ThreadsService } from './services/threads.service';

/**
 * Threads bounded module (TS-070-followup-2) — the authenticated thread +
 * thread-participant CRUD surface over `messaging.threads` +
 * `messaging.thread_participants`. PRD §6.7; PDD §8.2 + §13.1.
 *
 * Composition:
 *   - `ThreadsController` — HTTP boundary; validates with the contract-side
 *     Zod schemas, resolves the caller from the access token, honours
 *     `Idempotency-Key` on the writes, and row-scopes every operation by the
 *     caller's own participation row.
 *   - `ThreadsService` — owns the thread + participant persistence + the
 *     roster-management gate. Exported so the forthcoming event-driven
 *     auto-provisioner (TS-070-followup-3) can create threads without an HTTP
 *     round-trip, and so a future message-create flow can resolve membership.
 */
@Module({
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
