import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_PRICING_BANDS,
  PROVIDER_PRICING_DEFAULT_CURRENCY,
  PROVIDER_PRICING_UPDATED,
  type ProviderTier,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';

import { decimalStringToMinor, minorToDecimalString } from '../../../common/money';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import {
  ProviderPricingMetrics,
  pricingFailureOutcome,
  type ProviderPricingOutcome,
} from './provider-pricing-metrics';
import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `providers` row, narrowed to the
 * columns the pricing module reads / writes. Same TS-021-followup-2 /
 * TS-021-followup-3 rationale documented across the rest of the
 * codebase — Prisma's row types resolve inconsistently under our
 * tsconfig, so we project shapes by hand.
 *
 * `hourlyRate` is the Prisma `Decimal` instance (or null) — typed
 * structurally by the one method we call on it (`toString()`), which
 * yields the canonical `Decimal(12,2)` string (`"75.00"`).
 */
export interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly status: 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
  readonly tier: ProviderTier;
  readonly hourlyRate: { readonly toString: () => string } | null;
  readonly hourlyRateCurrency: string | null;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface UpdatePricingInput {
  /** Authoritative provider row id — set from the route param. */
  readonly providerId: string;
  /** The authenticated user attempting the edit. */
  readonly actorUserId: string;
  /** Requested hourly rate in minor units (cents). */
  readonly hourlyRateMinor: number;
  /** ISO-4217 currency code for the rate. */
  readonly currency: string;
  /**
   * Optional optimistic-concurrency precondition (mirrors TS-200-
   * followup-5). When set, the service refuses the update unless the
   * row's current `updatedAt` matches this value. The controller parses
   * the `If-Match` header into this field; `undefined` skips the check.
   */
  readonly ifMatchUpdatedAt?: Date | undefined;
}

export type ProviderPricingFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly providerId: string }
  | { readonly reason: 'forbidden'; readonly providerId: string }
  | {
      readonly reason: 'precondition_failed';
      readonly providerId: string;
      readonly currentUpdatedAt: Date;
    }
  | {
      readonly reason: 'unsupported_currency';
      readonly currency: string;
    }
  | {
      readonly reason: 'out_of_band';
      readonly tier: ProviderTier;
      readonly minHourlyRateMinor: number;
      readonly maxHourlyRateMinor: number;
      readonly requestedHourlyRateMinor: number;
    }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

/**
 * Internal exception thrown inside `prisma.$transaction` when the
 * outbox SDK rejects the payload. Caught by the outer service so the
 * surrounding transaction rolls back atomically and we surface a typed
 * failure rather than a 500. Same shape as
 * `ProviderProfileService.OutboxValidationFailedError`.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `ProviderPricingService` — the self-service pricing-band editor
 * (TS-204).
 *
 * Two surfaces:
 *
 *   - `getPricing(providerId)` / `getPricingByUserId(userId)` — return
 *     the `providers` row (caller maps to the `ProviderPricingRecord`
 *     DTO). `null` when no provider row exists.
 *
 *   - `updatePricing({ providerId, actorUserId, hourlyRateMinor,
 *     currency })` — the write path. Inside one Prisma transaction
 *     (after the read-side guards):
 *       1. Loads the provider row (404 if missing).
 *       2. Verifies the row's `user_id` matches `actorUserId` (403 if
 *          not — admin override is TS-204-followup-3).
 *       3. Optimistic-concurrency check (`If-Match`) — 412 on stale.
 *       4. Currency allow-list — Phase-1 USD-only; 422 otherwise.
 *       5. Per-tier band check — the rate must sit inside
 *          `PROVIDER_PRICING_BANDS[row.tier]`; 422 (out_of_band)
 *          otherwise. The band is keyed off the SERVER-known tier,
 *          never a client-supplied value (CLAUDE.md §12 — tier gating
 *          enforced at the service layer).
 *       6. No-op short-circuit — when the requested rate + currency
 *          exactly match the persisted pair, return the row unchanged
 *          (preserves `updated_at` as an accurate freshness signal).
 *       7. UPDATE the row + append a `provider.pricing_updated` outbox
 *          row via the shared SDK. Rolls back atomically on a
 *          validation reject.
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Self-service-first: the
 * authenticated user must own the provider row. Admin override lands
 * when `PermissionGuard` lifts to `packages/nest-auth` via
 * TS-052-followup-11 — captured as TS-204-followup-3.
 *
 * **Band as policy.** The per-tier min/max window lives in the contract
 * layer's `PROVIDER_PRICING_BANDS` (single source of truth shared with
 * the web-provider editor). Moving it into a configurable
 * `service_catalog` row is TS-204-followup-2 / TS-060-followup-2.
 *
 * **Booking quotes.** The rate flowing into `booking.base_price` is a
 * cross-service read wired by TS-204-followup-1 — out of scope here.
 */
@Injectable()
export class ProviderPricingService {
  private readonly logger = new Logger(ProviderPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    // Optional default (TS-204-followup-4) — the existing two-arg unit-
    // test call sites keep working; Nest injects the registered provider
    // in prod. No-op meter until `initMetrics` runs (CertificationsMetrics
    // precedent).
    private readonly metrics: ProviderPricingMetrics = new ProviderPricingMetrics(),
  ) {}

  /**
   * Fetch the provider row by id. Returns `null` when no row exists
   * (caller decides between 404 / 200-with-null based on the surface).
   */
  async getPricing(providerId: string): Promise<ProviderRow | null> {
    if (providerId.length === 0) return null;
    return (await this.prisma.provider.findUnique({
      where: { id: providerId },
    })) as ProviderRow | null;
  }

  /**
   * Fetch the provider row owned by `userId`. Returns `null` when the
   * user has no provider row (they haven't completed the application
   * yet). Used by the editor's initial-render GET surface.
   */
  async getPricingByUserId(userId: string): Promise<ProviderRow | null> {
    if (userId.length === 0) return null;
    return (await this.prisma.provider.findUnique({
      where: { userId },
    })) as ProviderRow | null;
  }

  /**
   * Public write entry point. Wraps {@link runUpdatePricing} in a
   * `provider.pricing.update` span (parenting the auto-instrumented
   * Prisma pg child spans) and records the bounded outcome + latency on
   * the pricing instruments (TS-204-followup-4). The internal
   * `runUpdatePricing` carries an `applied: 'set' | 'noop'` discriminant
   * on its success value so the no-op short-circuit is distinguished
   * from a real write on the scrape surface; this wrapper strips it back
   * to the public `Result<ProviderRow, ProviderPricingFailure>` the
   * controller consumes. Mirrors the
   * `ProviderCertificationsService.grant` shape (TS-052-followup-9).
   */
  async updatePricing(
    input: UpdatePricingInput,
  ): Promise<Result<ProviderRow, ProviderPricingFailure>> {
    return withSpan('provider.pricing.update', async (span) => {
      const startNs = process.hrtime.bigint();
      // Default to `error` so an unexpected throw records a bounded
      // outcome rather than mislabelling the sample.
      let outcome: ProviderPricingOutcome = 'error';
      try {
        const result = await this.runUpdatePricing(input);
        if (result.ok) {
          outcome = result.value.applied;
          return ok(result.value.row);
        }
        outcome = pricingFailureOutcome(result.error);
        return err(result.error);
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('provider.pricing.outcome', outcome);
        this.metrics.recordUpdate(outcome, seconds);
      }
    });
  }

  private async runUpdatePricing(
    input: UpdatePricingInput,
  ): Promise<
    Result<{ readonly row: ProviderRow; readonly applied: 'set' | 'noop' }, ProviderPricingFailure>
  > {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const existing = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
    })) as ProviderRow | null;

    if (existing === null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (existing.userId !== input.actorUserId) {
      // Admin override path is deferred to TS-204-followup-3. Until
      // then, a mismatch is a hard 403 — the controller surfaces
      // "Forbidden" without distinguishing "this row is someone else's"
      // from "you don't exist as a provider" to avoid leaking ownership.
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    // Optimistic concurrency (mirrors TS-200-followup-5). Fires AFTER
    // the 404 / 403 guards so callers who can't see the row get the
    // canonical refusal first.
    if (
      input.ifMatchUpdatedAt !== undefined &&
      input.ifMatchUpdatedAt.getTime() !== existing.updatedAt.getTime()
    ) {
      return err({
        reason: 'precondition_failed',
        providerId: input.providerId,
        currentUpdatedAt: existing.updatedAt,
      });
    }

    // Phase-1 USD-only. Normalise case so `usd` and `USD` are treated
    // identically; the stored value is always upper-cased.
    const normalizedCurrency = input.currency.toUpperCase();
    if (normalizedCurrency !== PROVIDER_PRICING_DEFAULT_CURRENCY) {
      return err({ reason: 'unsupported_currency', currency: input.currency });
    }

    // Band check against the SERVER-known tier (CLAUDE.md §12 — tier
    // gating at the service layer). The band is platform policy, never
    // client-supplied.
    const band = PROVIDER_PRICING_BANDS[existing.tier];
    if (
      input.hourlyRateMinor < band.minHourlyRateMinor ||
      input.hourlyRateMinor > band.maxHourlyRateMinor
    ) {
      return err({
        reason: 'out_of_band',
        tier: existing.tier,
        minHourlyRateMinor: band.minHourlyRateMinor,
        maxHourlyRateMinor: band.maxHourlyRateMinor,
        requestedHourlyRateMinor: input.hourlyRateMinor,
      });
    }

    // No-op short-circuit. When the requested rate + currency exactly
    // match the persisted pair, skip the transaction so `updated_at`
    // stays an accurate freshness signal (otherwise Prisma's
    // `@updatedAt` would bump on every PUT). The currency + band checks
    // above still ran, so a re-submit of a now-out-of-band rate (after
    // a tier drop) is correctly rejected before reaching here.
    const existingMinor =
      existing.hourlyRate !== null ? decimalStringToMinor(existing.hourlyRate.toString()) : null;
    if (
      existingMinor === input.hourlyRateMinor &&
      existing.hourlyRateCurrency === normalizedCurrency
    ) {
      this.logger.log(
        { providerId: input.providerId, actorUserId: input.actorUserId },
        'provider-pricing.update no-op short-circuit',
      );
      return ok({ row: existing, applied: 'noop' });
    }

    const now = new Date();

    try {
      const result = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<ProviderRow> => {
          const updated = (await tx.provider.update({
            where: { id: input.providerId },
            data: {
              hourlyRate: minorToDecimalString(input.hourlyRateMinor),
              hourlyRateCurrency: normalizedCurrency,
            },
          })) as ProviderRow;

          const eventId = `${input.providerId}.pricing_updated.${now.getTime()}`;
          const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: PROVIDER_PRICING_UPDATED,
            eventId,
            occurredAt: now,
            payload: {
              eventId,
              occurredAt: now.toISOString(),
              providerId: input.providerId,
              hourlyRateMinor: input.hourlyRateMinor,
              currency: normalizedCurrency,
              tier: existing.tier,
              actorUserId: input.actorUserId,
            },
          });
          if (appended.kind !== 'appended') {
            throw new OutboxValidationFailedError(appended.eventName, appended.issues);
          }

          return updated;
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          hourlyRateMinor: input.hourlyRateMinor,
          currency: normalizedCurrency,
          tier: existing.tier,
        },
        'provider-pricing.update ok',
      );

      return ok({ row: result, applied: 'set' });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-pricing.update outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }
}
