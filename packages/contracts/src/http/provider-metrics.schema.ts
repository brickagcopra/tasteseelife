import { z } from 'zod';

/**
 * Provider performance metrics — TS-305d.
 *
 * The shape of the read model service-provider derives from
 * service-booking's lifecycle events (PDD §8.2's `provider_metrics`
 * line; PRD §10.14). It is a *section* rather than a route of its own:
 * the only readers are the admin dossier and the 360 that aggregates
 * it, and a committee weighing a provider wants the numbers on the same
 * page as the credentials, not one round-trip away.
 *
 * Four properties are built into the contract rather than left to each
 * consumer, because getting any of them wrong turns a measurement into
 * an accusation.
 *
 * **1. "No number" is three different outcomes, and they are a
 * discriminated union so no consumer can blur them.**
 *
 *   - `measured`           — we have enough history to state a rate.
 *   - `insufficient_data`  — we have SOME history, but too little for a
 *                            rate to mean anything. One cancellation
 *                            out of one booking is not a 100%
 *                            cancellation rate, it is one cancellation.
 *   - `no_activity`        — we have never seen a booking for this
 *                            provider in this window at all.
 *
 * Collapsing `insufficient_data` into `no_activity` would tell a
 * reviewer a new provider has no record when they have a short one;
 * collapsing either into `measured` with a zero would state a fact we
 * do not have. The same reasoning as the export seam's
 * `no_records` / `not_applicable` split (TS-309b1).
 *
 * **2. Every figure names its window, and both windows are always
 * present.** A reliability number with an unstated window is a number
 * two people read differently — the reviewer asking "is this provider
 * dependable right now" and the tier rule asking "over their whole time
 * with us" want different answers and both are legitimate. Neither is
 * derivable from the other, so the contract carries both.
 *
 * **3. The field names refuse to claim attribution the platform cannot
 * establish.** `bookingsCanceledAfterAcceptance` is not
 * "cancellationsCaused": `booking.canceled` carries a
 * `canceledByUserId`, but service-provider cannot resolve whether that
 * id is the provider, the family payer or an admin without a
 * cross-service read CLAUDE.md §2.3 forbids — the wall TS-308c hit as
 * well. A family cancelling because a senior went into hospital would
 * otherwise be scored against the provider. Likewise
 * `bookingsExpiredUnanswered` is kept apart from `bookingsDeclined`
 * (never answering and declining are different behaviours) and from
 * admin-side declines (not the provider's act at all).
 *
 * **4. There is no rating, and its absence is the contract.** PDD
 * §8.2's original sketch lists `rating_avg`; nothing on this platform
 * captures a rating, and a nullable field would read as "no rating for
 * this provider" when the truth is "Taste and See does not collect
 * ratings". That is TS-305e, a product decision about consent and
 * moderation, not a column. `ProviderMetricsSectionSchema` is
 * `.strict()`, so adding one accidentally is a failing test.
 */

/**
 * The rolling window, in days, that `recent` figures cover.
 *
 * **90 days is an engineering default nobody with standing has
 * confirmed** — the same posture as TS-300's SLA budgets and TS-308a's
 * impossible-travel ceiling, and it is recorded here rather than buried
 * in a service so the number a consumer renders and the number the
 * service computes cannot drift. It is carried on the response as
 * `windowDays` so a surface can state the window it is showing instead
 * of hard-coding "90 days" into copy that would then have to be found
 * again when the number changes.
 *
 * Too short and an occasional provider never accumulates a sample; too
 * long and it stops describing the present, which is the only thing a
 * rolling window is for. Validating it wants a real booking corpus →
 * TS-305d-followup-1.
 */
export const PROVIDER_METRICS_WINDOW_DAYS = 90;

/**
 * Minimum number of decided bookings before a rate is stated at all.
 *
 * Below this the arithmetic still works and the answer is still
 * useless: a single cancelled booking is a 100% cancellation rate, and
 * a reviewer who sees that number on a screenshotted deliberation page
 * has been actively misled. Five is the smallest sample where a single
 * outcome does not dominate the figure — **also unconfirmed**, and it
 * is deliberately a floor on the *decided* count rather than on the
 * offered count, so a provider sitting on ten unanswered offers does
 * not cross it without having done anything.
 */
export const PROVIDER_METRICS_MIN_SAMPLE = 5;

/**
 * Rate as a percentage with one decimal place, 0–100 inclusive.
 *
 * Integer tenths of a percent on the wire (`952` = 95.2%) rather than a
 * float: this is not money, so CLAUDE.md §17.6 does not bite, but the
 * reason for the rule applies anyway — a rate that renders as
 * `95.19999999999999` on one surface and `95.2` on another is the same
 * class of defect, and a committee record should not disagree with
 * itself. Consumers divide by 10 at the presentation edge and nowhere
 * else.
 */
export const ProviderMetricsRateSchema = z.number().int().min(0).max(1000);

/**
 * The counted facts behind every rate, always shipped alongside them.
 *
 * A rate without its denominator cannot be argued with, and this
 * surface exists to be argued with — the numbers land in a review that
 * can end someone's work on the platform. `decidedBookings` is the
 * denominator the rates actually use, stated once rather than left to
 * be re-derived (and mis-derived) per consumer.
 */
export const ProviderMetricsCountsSchema = z
  .object({
    /** Offers seen — bookings whose request instant we know. */
    bookingsOffered: z.number().int().min(0),
    /** Offers the provider accepted. */
    bookingsAccepted: z.number().int().min(0),
    /** Offers the provider explicitly declined (`provider_declined`). */
    bookingsDeclined: z.number().int().min(0),
    /**
     * Offers that lapsed without an answer (`window_expired`). Kept
     * apart from `bookingsDeclined` on purpose: a decline is a decision
     * and a lapse is a silence, and the remedies differ.
     */
    bookingsExpiredUnanswered: z.number().int().min(0),
    /**
     * Offers declined by ops on the provider's behalf
     * (`admin_declined`). Reported so the funnel adds up, and excluded
     * from every rate — it is not the provider's act.
     */
    bookingsDeclinedByAdmin: z.number().int().min(0),
    /** Accepted bookings that reached `completed`. */
    bookingsCompleted: z.number().int().min(0),
    /**
     * Bookings cancelled after this provider had accepted them, BY ANY
     * PARTY. See the module doc-block: the platform cannot attribute a
     * cancellation, so this name states what is known and no more.
     */
    bookingsCanceledAfterAcceptance: z.number().int().min(0),
    /**
     * The denominator the completion and cancellation rates use —
     * accepted bookings that have reached a terminal position. An
     * accepted booking still in the future is neither a success nor a
     * failure and belongs in neither.
     */
    decidedBookings: z.number().int().min(0),
  })
  .strict();
export type ProviderMetricsCounts = z.infer<typeof ProviderMetricsCountsSchema>;

/**
 * One window's figures.
 *
 * `state` is the discriminator described in the module doc-block. Note
 * that `insufficient_data` still carries the counts: a reviewer is
 * entitled to see "two bookings, both completed" — what they must not
 * be shown is "100%".
 */
export const ProviderMetricsWindowSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('measured'),
      counts: ProviderMetricsCountsSchema,
      /** `bookingsCompleted / decidedBookings`. */
      completionRate: ProviderMetricsRateSchema,
      /** `bookingsCanceledAfterAcceptance / decidedBookings`. */
      cancellationRate: ProviderMetricsRateSchema,
      /**
       * `bookingsAccepted / (accepted + declined + expired)`. Excludes
       * admin declines, and excludes offers still inside their accept
       * window — an unanswered offer that has not yet lapsed is not
       * yet a refusal.
       */
      acceptanceRate: ProviderMetricsRateSchema,
      /**
       * Median offer-to-response gap in whole seconds, or null when no
       * booking in this window has both instants on record.
       *
       * A MEDIAN, not a mean, and the distinction is the point: one
       * offer answered after a fortnight's holiday would drag a mean
       * far enough to misdescribe every other week of the provider's
       * behaviour. PDD §8.2 says `response_time_p50` for the same
       * reason.
       */
      medianResponseSeconds: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal('insufficient_data'),
      counts: ProviderMetricsCountsSchema,
      /** The floor not yet reached — `PROVIDER_METRICS_MIN_SAMPLE`. */
      minimumDecidedBookings: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal('no_activity'),
    })
    .strict(),
]);
export type ProviderMetricsWindow = z.infer<typeof ProviderMetricsWindowSchema>;

/**
 * The metrics section carried on the admin dossier and the 360.
 *
 * `firstObservedAt` is how far back the record goes and is not
 * cosmetic: a lifetime figure over three weeks and a lifetime figure
 * over three years are different claims wearing the same label, and a
 * reviewer cannot tell them apart from a rate. Null when nothing has
 * ever been observed for the provider.
 */
export const ProviderMetricsSectionSchema = z
  .object({
    lifetime: ProviderMetricsWindowSchema,
    recent: ProviderMetricsWindowSchema,
    /** Always `PROVIDER_METRICS_WINDOW_DAYS`; carried, never assumed. */
    windowDays: z.number().int().positive(),
    firstObservedAt: z.string().datetime().nullable(),
    lastObservedAt: z.string().datetime().nullable(),
    /** Composition wall-clock of this read. */
    computedAt: z.string().datetime(),
  })
  .strict();
export type ProviderMetricsSection = z.infer<typeof ProviderMetricsSectionSchema>;
