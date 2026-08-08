import { Injectable, Logger } from '@nestjs/common';
import { PROVIDER_METRICS_UPDATED } from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import type { BookingFactContribution } from '../booking-fact-projection';

/**
 * Write half of the provider metrics read model (TS-305d).
 *
 * Applies one event's `BookingFactContribution` to
 * `provider_booking_facts` and re-derives that provider's row in
 * `provider_metrics`, both inside a single transaction.
 *
 * **Everything is `COALESCE`, and that is the idempotency guarantee.**
 * A column is written only while it is still null, so replaying an
 * event is a no-op and events that arrive out of order converge to the
 * same row — a `booking.completed` seen before its `booking.created`
 * creates the row with an outcome and no offer instant, and the later
 * `created` fills the offer instant without disturbing the outcome. The
 * consumer dedup table is a cache in front of this, not the guarantee
 * itself (CLAUDE.md §5.3).
 *
 * The one field that is NOT coalesced is `provider_id`, which is set on
 * insert and never updated. A booking does not change provider on this
 * platform; if one ever did, the fact row's history would belong to
 * whoever held it, and silently reassigning it would move a completed
 * visit onto somebody else's record. A mismatch is logged loudly
 * instead.
 *
 * **The rollup is RECOMPUTED, never incremented.** An increment is
 * wrong the first time an event is replayed or applied out of order;
 * a recompute cannot be. The cost is one aggregate over one provider's
 * facts per event, served by
 * `provider_booking_facts_provider_outcome_idx`.
 *
 * **Raw SQL, deliberately.** `INSERT … ON CONFLICT DO UPDATE SET col =
 * COALESCE(existing.col, EXCLUDED.col)` is a single atomic statement
 * with no read-modify-write window; the equivalent through Prisma's
 * typed API is a read, a decision and a write, which races with the
 * second pod. The rules that decide WHAT is written live in
 * `booking-fact-projection.ts` as pure functions, so what remains here
 * is mechanical — which is the trade that keeps this testable while
 * Docker is unavailable (integration coverage: TS-305d-followup-2).
 */
/**
 * Raised when the outbox SDK refuses the event — a payload that does not
 * validate against the registry schema. Mirrors the local class in
 * `provider-certifications.service.ts`; the SDK exports no such error, and
 * each producer names its own so a stack trace says which surface failed.
 *
 * Throwing rolls the fact write back with it. That is the point: a
 * projection that advanced while its announcement failed is exactly the
 * silent divergence this event exists to prevent.
 */
class MetricsOutboxValidationFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: unknown,
  ) {
    super(`outbox refused ${eventName}: payload failed registry validation`);
    this.name = 'MetricsOutboxValidationFailedError';
  }
}

@Injectable()
export class ProviderMetricsProjectorService {
  private readonly logger = new Logger(ProviderMetricsProjectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Apply one event's contribution and refresh the provider's rollup.
   *
   * Returns nothing: the caller is an outbox handler, and a handler
   * that throws is retried by the SDK, which is the behaviour we want
   * for a transient database failure.
   */
  async apply(contribution: BookingFactContribution): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "provider"."provider_booking_facts" (
          "booking_id", "provider_id", "service_kind", "offered_at",
          "responded_at", "response_kind", "decline_kind",
          "outcome", "outcome_at", "cancellation_reason",
          "canceled_previous_status", "created_at", "updated_at"
        ) VALUES (
          ${contribution.bookingId},
          ${contribution.providerId},
          ${contribution.serviceKind ?? null},
          ${contribution.offeredAt ?? null},
          ${contribution.respondedAt ?? null},
          ${contribution.responseKind ?? null},
          ${contribution.declineKind ?? null},
          ${contribution.outcome ?? null},
          ${contribution.outcomeAt ?? null},
          ${contribution.cancellationReason ?? null},
          ${contribution.canceledPreviousStatus ?? null},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("booking_id") DO UPDATE SET
          "service_kind"  = COALESCE("provider_booking_facts"."service_kind", EXCLUDED."service_kind"),
          "offered_at"    = COALESCE("provider_booking_facts"."offered_at", EXCLUDED."offered_at"),
          "responded_at"  = COALESCE("provider_booking_facts"."responded_at", EXCLUDED."responded_at"),
          "response_kind" = COALESCE("provider_booking_facts"."response_kind", EXCLUDED."response_kind"),
          "decline_kind"  = COALESCE("provider_booking_facts"."decline_kind", EXCLUDED."decline_kind"),
          "outcome"       = COALESCE("provider_booking_facts"."outcome", EXCLUDED."outcome"),
          "outcome_at"    = COALESCE("provider_booking_facts"."outcome_at", EXCLUDED."outcome_at"),
          "cancellation_reason" =
            COALESCE("provider_booking_facts"."cancellation_reason", EXCLUDED."cancellation_reason"),
          "canceled_previous_status" =
            COALESCE("provider_booking_facts"."canceled_previous_status",
                     EXCLUDED."canceled_previous_status"),
          "updated_at" = CURRENT_TIMESTAMP
      `;

      const completedBookingCount = await this.recomputeRollup(tx, contribution.providerId);

      // TS-053-followup-4a. The discovery document carries
      // `completedBookingCount`, and only a COMPLETION can move it —
      // `bookings_completed` counts facts whose outcome is `completed`,
      // and no other lifecycle event sets that. Emitting on all five
      // would re-project an entire search document per booking
      // transition to change an integer that did not change.
      //
      // If a second projected figure ever lands on the discovery
      // document, widen this trigger DELIBERATELY rather than letting
      // it drift into "emitted whenever the projector runs".
      if (contribution.outcome === 'completed') {
        await this.emitMetricsUpdated(tx, contribution, completedBookingCount);
      }
    });
  }

  /**
   * Re-derive `provider_metrics` for one provider from their facts.
   *
   * The counting rules here MUST agree with `countFacts` in
   * `metrics-computation.ts` — the same definitions expressed twice,
   * once in SQL for the many-provider reads and once in TypeScript for
   * the single-provider read. That duplication is the honest cost of
   * having both, and it is the first thing to check if a rollup and a
   * dossier ever disagree. `provider-metrics-rollup.test.ts` pins the
   * definitions in one place so a change to either has to visit both.
   *
   * `response_seconds_total` / `response_samples` exclude
   * `window_expired`, matching `responseGapSeconds`: an expiry carries
   * a response instant but nobody responded, and counting it would
   * report the accept window's length as the provider's speed.
   */
  private async recomputeRollup(tx: PrismaTransactionClient, providerId: string): Promise<number> {
    await tx.$executeRaw`
      INSERT INTO "provider"."provider_metrics" (
        "provider_id", "bookings_offered", "bookings_accepted", "bookings_declined",
        "bookings_expired", "bookings_completed", "bookings_canceled_after_acceptance",
        "response_seconds_total", "response_samples",
        "first_observed_at", "last_observed_at", "computed_at", "created_at", "updated_at"
      )
      SELECT
        ${providerId},
        count(*) FILTER (WHERE "offered_at" IS NOT NULL),
        count(*) FILTER (WHERE "response_kind" = 'accepted'),
        count(*) FILTER (WHERE "response_kind" = 'declined' AND "decline_kind" = 'provider_declined'),
        count(*) FILTER (WHERE "response_kind" = 'declined' AND "decline_kind" = 'window_expired'),
        count(*) FILTER (WHERE "outcome" = 'completed'),
        count(*) FILTER (WHERE "outcome" = 'canceled' AND "response_kind" = 'accepted'),
        COALESCE(sum(
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ("responded_at" - "offered_at"))))::bigint
        ) FILTER (
          WHERE "responded_at" IS NOT NULL
            AND "offered_at" IS NOT NULL
            AND "decline_kind" IS DISTINCT FROM 'window_expired'
            AND "responded_at" >= "offered_at"
        ), 0),
        count(*) FILTER (
          WHERE "responded_at" IS NOT NULL
            AND "offered_at" IS NOT NULL
            AND "decline_kind" IS DISTINCT FROM 'window_expired'
            AND "responded_at" >= "offered_at"
        ),
        min(LEAST("offered_at", "responded_at", "outcome_at")),
        max(GREATEST("offered_at", "responded_at", "outcome_at")),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM "provider"."provider_booking_facts"
      WHERE "provider_id" = ${providerId}
      ON CONFLICT ("provider_id") DO UPDATE SET
        "bookings_offered"   = EXCLUDED."bookings_offered",
        "bookings_accepted"  = EXCLUDED."bookings_accepted",
        "bookings_declined"  = EXCLUDED."bookings_declined",
        "bookings_expired"   = EXCLUDED."bookings_expired",
        "bookings_completed" = EXCLUDED."bookings_completed",
        "bookings_canceled_after_acceptance" = EXCLUDED."bookings_canceled_after_acceptance",
        "response_seconds_total" = EXCLUDED."response_seconds_total",
        "response_samples"       = EXCLUDED."response_samples",
        "first_observed_at"      = EXCLUDED."first_observed_at",
        "last_observed_at"       = EXCLUDED."last_observed_at",
        "computed_at"            = CURRENT_TIMESTAMP,
        "updated_at"             = CURRENT_TIMESTAMP
    `;

    // Read back rather than deriving from the write: the recompute is a
    // single aggregate statement and `$executeRaw` yields a row count,
    // not the row. One indexed primary-key lookup inside a transaction
    // that has just written it is cheaper than making the upsert a
    // `$queryRaw` with RETURNING and hand-typing its result.
    const row = await tx.providerMetrics.findUnique({
      where: { providerId },
      select: { bookingsCompleted: true },
    });
    const completedBookingCount = row?.bookingsCompleted ?? 0;

    this.logger.debug({ providerId, completedBookingCount }, 'provider-metrics: rollup recomputed');

    return completedBookingCount;
  }

  /**
   * Append `provider.metrics_updated` so the search-indexer re-projects
   * this provider's discovery document.
   *
   * **In the same transaction as the fact write** — the outbox pattern
   * (CLAUDE.md §5.3). An emission outside it could announce a count the
   * rollup never committed.
   *
   * **The event id is DETERMINISTIC**, keyed to the provider and the
   * booking that completed. A redelivered `booking.completed` recomputes
   * the same rollup and produces the same id, which the outbox's
   * `ON CONFLICT (event_id) DO NOTHING` swallows — so the fact write and
   * its announcement are idempotent by the same argument, rather than
   * the write being idempotent and the emission being absorbed by a
   * consumer that has to be careful. Same shape as TS-308a's
   * `impossible-travel:{prevId}:{curId}`.
   */
  private async emitMetricsUpdated(
    tx: PrismaTransactionClient,
    contribution: BookingFactContribution,
    completedBookingCount: number,
  ): Promise<void> {
    const eventId = `provider-metrics:${contribution.providerId}:${contribution.bookingId}`;
    const occurredAt = contribution.outcomeAt ?? new Date();

    const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
      eventName: PROVIDER_METRICS_UPDATED,
      eventId,
      occurredAt,
      payload: {
        eventId,
        occurredAt: occurredAt.toISOString(),
        providerId: contribution.providerId,
        completedBookingCount,
      },
    });
    if (appended.kind !== 'appended') {
      // Rolls the fact write back — the search index would otherwise sit
      // on a stale count with nothing anywhere saying so.
      throw new MetricsOutboxValidationFailedError(appended.eventName, appended.issues);
    }

    this.logger.log(
      { providerId: contribution.providerId, completedBookingCount },
      'provider-metrics: metrics_updated appended',
    );
  }
}
