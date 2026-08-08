import { Injectable } from '@nestjs/common';
import type {
  BookingCreated,
  SearchPerformed,
  SearchResultClicked,
} from '@taste-and-see/contracts';
import type { ConsumerEventEnvelope } from '@taste-and-see/nest-outbox-consumer';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Outcome of an idempotent raw-event insert.
 *
 *   - `persisted: true`  — the row was inserted (first time we've seen this
 *     `event_id`).
 *   - `persisted: false` — the row already existed; this was a redelivery.
 *     The caller logs it and returns success so the SDK XACKs (CLAUDE.md
 *     §5.3 — consumers idempotent on `event_id`).
 */
export interface PersistResult {
  readonly persisted: boolean;
}

/**
 * Persists raw domain events into the interim Postgres landing tables
 * (TS-217-prep-3a; PDD §23.1 — raw-event retention).
 *
 * **Why a landing table, not the live mart.** The TS-217 search-relevance
 * dashboard is computed by a nightly aggregation (TS-217-prep-3b) over the
 * raw event stream. Persisting the raw events first decouples ingest (cheap,
 * append-only, per-event) from aggregation (windowed, recomputable). The
 * Postgres tables are the explicitly-interim store for the Cassandra
 * `analytics.events` keyspace (PDD §8.3 / TS-217-prep-3a-followup-1) — the
 * prep-3 acceptance allows "a Postgres landing table in the interim".
 *
 * **Idempotency (CLAUDE.md §5.3).** Each table's `event_id` PK is the PRIMARY
 * line of defence — a redelivered event is a no-op via
 * `createMany({ skipDuplicates: true })` (Postgres `ON CONFLICT DO NOTHING`,
 * `count === 0`). The consumer SDK's `outbox_consumer_dedup` table is the
 * secondary line. Both pin the same `envelope.eventId` key, so a redelivery
 * short-circuits at whichever layer fires first.
 *
 * **Time axis.** We persist `envelope.occurredAt` (the relay-parsed producer
 * wall-clock `Date`) as `occurred_at` rather than re-parsing the payload's
 * ISO string — the envelope timestamp is the relay's canonical value and the
 * aggregation windows on it. `consumed_at` defaults to `now()` at the DB so
 * consumer-lag (`consumed_at - occurred_at`) is observable.
 *
 * **Tenant scoping.** `SearchEvent` / `BookingCreatedEvent` are platform-wide
 * read-side projections with no tenant axis (search + booking telemetry
 * aggregates across every household), so both are listed in `unscopedModels`
 * in `app.module.ts`. The consumer handler additionally wraps the dispatch in
 * `runWithoutTenantContext` (belt-and-braces — see `OutboxConsumersModule`).
 */
@Injectable()
export class RawEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a `search.performed` event. Idempotent on `envelope.eventId`.
   * Mirrors `SearchPerformedSchema`
   * (`packages/contracts/src/events/search.ts`); `queryText` may be null
   * (a no-text discovery browse).
   */
  async persistSearchPerformed(
    envelope: ConsumerEventEnvelope,
    payload: SearchPerformed,
  ): Promise<PersistResult> {
    const { count } = await this.prisma.searchEvent.createMany({
      data: [
        {
          eventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          actorUserId: payload.actorUserId,
          queryText: payload.queryText,
          sort: payload.sort,
          hasGeo: payload.hasGeo,
          appliedFilters: payload.appliedFilters,
          filterTiers: payload.filterTiers,
          resultCount: payload.resultCount,
          totalEstimate: payload.totalEstimate,
          zeroResults: payload.zeroResults,
          page: payload.page,
          liveMode: payload.liveMode,
          producerService: envelope.producerService,
        },
      ],
      skipDuplicates: true,
    });

    return { persisted: count > 0 };
  }

  /**
   * Persist a `search.result_clicked` event. Idempotent on `envelope.eventId`
   * (TS-217-prep-4b). Mirrors `SearchResultClickedSchema`
   * (`packages/contracts/src/events/search.ts`). `searchId` is the
   * search-correlation token (= the originating `search.performed` event's
   * `event_id`) the CTR-by-position mart joins on.
   */
  async persistSearchResultClicked(
    envelope: ConsumerEventEnvelope,
    payload: SearchResultClicked,
  ): Promise<PersistResult> {
    const { count } = await this.prisma.searchClickEvent.createMany({
      data: [
        {
          eventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          searchId: payload.searchId,
          actorUserId: payload.actorUserId,
          providerId: payload.providerId,
          position: payload.position,
          producerService: envelope.producerService,
        },
      ],
      skipDuplicates: true,
    });

    return { persisted: count > 0 };
  }

  /**
   * Persist a `booking.created` event. Idempotent on `envelope.eventId`.
   * Mirrors `BookingCreatedSchema` (`packages/contracts/src/events/booking.ts`).
   * The money fields are carried for the prep-3b conversion mart's
   * GMV-by-search overlay — they are NOT a monetary source-of-truth here
   * (accounting owns that — PDD §11.2).
   */
  async persistBookingCreated(
    envelope: ConsumerEventEnvelope,
    payload: BookingCreated,
  ): Promise<PersistResult> {
    const { count } = await this.prisma.bookingCreatedEvent.createMany({
      data: [
        {
          eventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          bookingId: payload.bookingId,
          householdId: payload.householdId,
          // TS-217-prep-4c — the originating search-correlation token (null when
          // the booking did not arrive from a search). Enables the precise
          // per-search conversion mart (join search_id == search_events.event_id).
          searchId: payload.searchId ?? null,
          seniorId: payload.seniorId,
          providerId: payload.providerId,
          serviceKind: payload.serviceKind,
          scheduledStart: new Date(payload.scheduledStart),
          scheduledEnd: new Date(payload.scheduledEnd),
          currency: payload.currency,
          basePriceMinor: payload.basePriceMinor,
          commissionRateBps: payload.commissionRateBps,
          commissionAmountMinor: payload.commissionAmountMinor,
          finalPriceMinor: payload.finalPriceMinor,
          producerService: envelope.producerService,
        },
      ],
      skipDuplicates: true,
    });

    return { persisted: count > 0 };
  }
}
