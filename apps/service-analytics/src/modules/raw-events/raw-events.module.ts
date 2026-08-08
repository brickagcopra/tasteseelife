import { Module } from '@nestjs/common';

import { RawEventsService } from './raw-events.service';

/**
 * Raw-event persistence module (TS-217-prep-3a).
 *
 * Provides + exports `RawEventsService`, the persistence layer the outbox
 * consumer handlers (`OutboxConsumersModule`) call to land `search.performed`
 * / `booking.created` events into the interim Postgres landing tables. Kept as
 * its own module so the persistence logic has a single owner (CLAUDE.md §2.3 —
 * services own logic, repositories own persistence) and the consumer module
 * only orchestrates.
 *
 * `PrismaService` is supplied by the `@Global` `PrismaModule`, so this module
 * does not re-import it.
 */
@Module({
  providers: [RawEventsService],
  exports: [RawEventsService],
})
export class RawEventsModule {}
