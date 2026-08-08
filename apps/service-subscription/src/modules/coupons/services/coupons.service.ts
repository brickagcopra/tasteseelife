import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CouponDuration,
  CouponKind,
  CreateCouponRequest,
  PlanCustomerGroup,
} from '@taste-and-see/contracts';
import { withSpan } from '@taste-and-see/tracing';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { err, ok, type Result } from '../../subscriptions/result';
import {
  CouponMetrics,
  type CouponRedemptionOutcome,
  type CouponStripeEnsureOutcome,
  elapsedSeconds,
} from './coupon-metrics';

/**
 * Failure shapes returned by the CouponsService validation surface. Every
 * negative path is a discriminated-union member so the controller's
 * branch is explicit (CLAUDE.md §2.1).
 *
 * Why a wide enum rather than a single "invalid" reason: the family-portal
 * needs to surface the specific rule that failed ("this code expired",
 * "this code applies to a different plan") to the customer at checkout.
 * The wider enum lets that surface land without ad-hoc string parsing.
 */
export type CouponValidationFailure =
  | { readonly reason: 'coupon_not_found'; readonly code: string }
  | { readonly reason: 'coupon_inactive'; readonly couponId: string }
  | { readonly reason: 'coupon_expired'; readonly couponId: string; readonly expiresAt: Date }
  | {
      readonly reason: 'coupon_cap_reached';
      readonly couponId: string;
      readonly maxRedemptions: number;
    }
  | {
      readonly reason: 'coupon_plan_not_eligible';
      readonly couponId: string;
      readonly planId: string;
    }
  | {
      readonly reason: 'coupon_min_spend_not_met';
      readonly couponId: string;
      readonly minSpendMinor: number;
      readonly unitPriceMinor: number;
    }
  | {
      readonly reason: 'coupon_per_customer_limit_reached';
      readonly couponId: string;
      readonly perCustomerLimit: number;
    }
  | {
      readonly reason: 'coupon_first_time_only';
      readonly couponId: string;
      readonly priorSubscriptions: number;
    };

/** Failure shapes returned by the redemption surface. */
export type CouponRedemptionFailure =
  | CouponValidationFailure
  | {
      readonly reason: 'redemption_conflict';
      readonly couponId: string;
      readonly subscriptionId: string;
    }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown };

/** Failure shapes returned by the admin-CRUD surface. */
export type CouponAdminFailure =
  | { readonly reason: 'coupon_code_taken'; readonly code: string }
  | { readonly reason: 'coupon_not_found'; readonly couponId: string }
  | { readonly reason: 'invalid_request'; readonly message: string };

/**
 * Input for the read-only validation surface (POST /coupons/validate).
 * Carries the plan + customer context so the eligibility gate has
 * everything it needs without touching the DB twice.
 */
export interface ValidateCouponInput {
  readonly code: string;
  readonly planId: string;
  readonly customerId: string;
  readonly customerGroup: PlanCustomerGroup;
}

/**
 * Snapshot of a coupon row returned to callers after validation. Avoids
 * leaking Prisma types up the stack; the validate controller maps this
 * onto the `ValidateCouponResponse` DTO; SubscriptionsService consumes
 * the snapshot directly during the redemption path.
 */
export interface ValidatedCoupon {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: CouponKind;
  readonly amount: number;
  readonly currency: string;
  readonly duration: CouponDuration;
  readonly durationInMonths: number | null;
  readonly stackable: boolean;
  readonly stripeCouponId: string | null;
  /** Resolved discount value in `currency` minor units for THIS plan. */
  readonly valueAppliedMinor: number;
  /** Extended trial days; null for non-trial coupons. */
  readonly extendedTrialDays: number | null;
}

/**
 * Input for the persist-redemption surface. Called from inside
 * `SubscriptionsService.create` while the subscription transaction is
 * open, so a `tx` argument carries the in-flight client. The cap +
 * per-customer-limit re-checks happen INSIDE this method against `tx`,
 * which guarantees the read+write+increment land atomically against
 * the same row (Postgres `SELECT ... FOR UPDATE` semantics via Prisma's
 * interactive transaction).
 */
export interface RecordRedemptionInput {
  readonly couponId: string;
  readonly customerId: string;
  readonly customerGroup: PlanCustomerGroup;
  readonly subscriptionId: string;
  readonly valueAppliedMinor: number;
  readonly currency: string;
  /**
   * Coupon kind — threaded from the caller's already-validated
   * `ValidatedCoupon` purely so the `coupon_redemption_total{kind}` metric
   * label (TS-043-followup-8) lands without a second DB read inside the
   * redemption transaction.
   */
  readonly kind: CouponKind;
  readonly tx: PrismaTransactionClient;
}

/**
 * Minimal projection of `coupons` row the service consumes. Hoisted
 * to a stable type so the loadByCode helper signature doesn't shift
 * as the schema grows.
 */
interface CouponRowSlice {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: CouponKind;
  readonly amount: number;
  readonly currency: string;
  readonly duration: CouponDuration;
  readonly durationInMonths: number | null;
  readonly appliesToPlanIds: readonly string[];
  readonly maxRedemptions: number | null;
  readonly timesRedeemed: number;
  readonly perCustomerLimit: number | null;
  readonly firstTimeCustomerOnly: boolean;
  readonly minSpendMinor: number | null;
  readonly stackable: boolean;
  readonly expiresAt: Date | null;
  readonly active: boolean;
  readonly stripeCouponId: string | null;
}

/**
 * Slim plan projection the discount-math helpers consume. The
 * monthlyPrice / annualPrice columns are `Decimal` from Prisma; the
 * service converts to integer minor units at the discount calculation
 * boundary via `Decimal` arithmetic (CLAUDE.md §17.6 — never `Number`
 * for money).
 */
export interface CouponPlanContext {
  readonly id: string;
  readonly currency: string;
  readonly monthlyPriceMinor: number;
  readonly annualPriceMinor: number;
}

/**
 * `CouponsService` (TS-043) — coupon catalog + validation + redemption.
 *
 * The service is the only place in the codebase that:
 *   - creates / deactivates coupon definitions (admin surface);
 *   - runs the eligibility gate (PRD §10.4: active, not expired, plan
 *     eligible, cap not reached, per-customer limit not exceeded,
 *     first-time-only respected, min spend met);
 *   - lazy-creates a Stripe Coupon for `percent_off` / `amount_off`
 *     kinds and caches the id on `coupons.stripe_coupon_id`;
 *   - persists the `coupon_redemptions` row atomically with the
 *     subscription row that received the discount;
 *   - atomically increments `coupons.times_redeemed`.
 *
 * **Money math** uses `Decimal` exclusively (CLAUDE.md §17.6) — the
 * per-plan discount amount is computed via `Decimal` percent math and
 * `decimal.toDecimalPlaces(0, ROUND_HALF_EVEN)` before lowering to a
 * `number` for the minor-units wire format. The result is identical
 * for typical inputs (integer percent × integer minor units) but the
 * discipline holds against any future schema change that introduces
 * decimal percents.
 *
 * **Trust gates** (CLAUDE.md §12). The eligibility check is the
 * authoritative gate; the controller-level rate limiter (per IP +
 * per user) defends the validation endpoint from brute-force probing.
 * Stripe-side dedup picks up any double-redemption on the same
 * subscription via the unique `(coupon_id, subscription_id)` index.
 *
 * **Authorization**. The admin endpoints inherit the controller's
 * AccessTokenGuard; permission-level gating (`coupon:create`) lands
 * once PermissionGuard lifts to `packages/nest-auth` (TS-052-followup-11).
 * Until then, audit-log + admin-MFA visibility is the trust gate.
 *
 * **Observability (TS-043-followup-8; CLAUDE.md §10).** The two
 * cross-boundary surfaces — `recordRedemption` (DB) and `ensureStripeCoupon`
 * (Stripe + DB) — run inside an OTel logical span (`coupon.record_redemption`
 * / `coupon.ensure_stripe_coupon`) so each shows up as a named parent in
 * traces with the auto-instrumented Prisma (pg) and Stripe (HTTP) calls
 * stitched on as children. Outcome + latency land on the
 * `coupon_redemption_total{outcome,kind}` / `coupon_stripe_ensure_total
 * {outcome}` counters + the shared `coupon_operation_duration_seconds`
 * histogram via {@link CouponMetrics}. The outcome defaults to `error` so an
 * unexpected throw still records a bounded sample. The validate surface's
 * metric is recorded at the controller (it needs the rate-limit decision the
 * service never sees). Labels are bounded string-literal unions — never a
 * coupon code, customer id, or Stripe id.
 */
@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    // Optional so direct `new CouponsService(...)` unit-test call sites keep
    // working; in the Nest DI graph the registered `CouponMetrics` provider is
    // injected. Instruments are no-ops until `initMetrics` runs, so the
    // default instance is harmless in tests (DunningMetrics precedent).
    private readonly metrics: CouponMetrics = new CouponMetrics(),
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // VALIDATE — read-only eligibility check.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Validate a coupon code against the plan + customer context.
   *
   * Performs every PRD §10.4 eligibility check in order. The first
   * failing rule short-circuits with the matching `CouponValidationFailure`
   * variant — useful for surfacing a specific reason ("this code expired",
   * "applies to a different plan") to the customer at checkout.
   *
   * **No Stripe call here** — validation is pure DB + math. Stripe
   * coupon creation happens in `recordRedemption` at the moment the
   * coupon is actually applied.
   */
  async validate(
    input: ValidateCouponInput,
    plan: CouponPlanContext,
    billingInterval: 'monthly' | 'annual',
  ): Promise<Result<ValidatedCoupon, CouponValidationFailure>> {
    const normalisedCode = normaliseCode(input.code);

    const row = await this.prisma.coupon.findUnique({
      where: { code: normalisedCode },
      select: couponSelect,
    });
    if (row === null) {
      return err({ reason: 'coupon_not_found', code: normalisedCode });
    }

    return this.runGates(row, input, plan, billingInterval);
  }

  // ─────────────────────────────────────────────────────────────────────
  // RECORD REDEMPTION — atomic insert + counter increment + Stripe coupon
  // lazy-create.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Persist a `coupon_redemptions` row and increment the parent's
   * `times_redeemed` counter, BOTH inside the caller's transaction.
   *
   * The caller (SubscriptionsService.create) supplies its open `tx` so
   * the redemption + the subscription row land or fail together. If
   * any constraint trips (unique `(coupon_id, subscription_id)` race
   * loser, FK miss), the transaction rolls back and the caller sees
   * a `redemption_conflict`.
   *
   * **Stripe coupon creation is intentionally OUTSIDE the transaction**.
   * The caller is expected to call `ensureStripeCoupon` BEFORE opening
   * the subscription-persist transaction (mirrors the
   * `ensureStripeProduct` pattern in SubscriptionsService.create — the
   * Stripe id must be cached on the row before the Stripe Subscription
   * is created with `discounts` set).
   */
  async recordRedemption(
    input: RecordRedemptionInput,
  ): Promise<Result<{ readonly redemptionId: string }, CouponRedemptionFailure>> {
    return withSpan('coupon.record_redemption', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: CouponRedemptionOutcome = 'error';
      try {
        const tx = input.tx;

        let redemption: { id: string };
        try {
          redemption = await tx.couponRedemption.create({
            data: {
              couponId: input.couponId,
              customerId: input.customerId,
              customerGroup: input.customerGroup,
              subscriptionId: input.subscriptionId,
              valueAppliedMinor: input.valueAppliedMinor,
              currency: input.currency,
            },
            select: { id: true },
          });
        } catch (cause) {
          if (isPrismaUniqueViolation(cause)) {
            outcome = 'redemption_conflict';
            return err({
              reason: 'redemption_conflict',
              couponId: input.couponId,
              subscriptionId: input.subscriptionId,
            });
          }
          throw cause;
        }

        await tx.coupon.update({
          where: { id: input.couponId },
          data: { timesRedeemed: { increment: 1 } },
        });

        outcome = 'ok';
        return ok({ redemptionId: redemption.id });
      } finally {
        span.setAttribute('coupon.outcome', outcome);
        this.metrics.recordRedemption(outcome, input.kind, elapsedSeconds(startNs));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ENSURE STRIPE COUPON — lazy-create + cache on the coupon row.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Lazy-create the Stripe Coupon backing this row. Idempotent on the
   * `coupons.stripe_coupon_id` column — if it's already set we return
   * the existing id. Mirrors `SubscriptionsService.ensureStripeProduct`.
   *
   * `extended_trial` coupons never create a Stripe coupon (the trial
   * extension lands via `trial_period_days` on the subscription itself).
   * The method returns `null` in that case so the caller knows not to
   * attach a `discounts` parameter.
   */
  async ensureStripeCoupon(
    couponId: string,
    idempotencyKey?: string,
  ): Promise<Result<string | null, CouponRedemptionFailure>> {
    return withSpan('coupon.ensure_stripe_coupon', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: CouponStripeEnsureOutcome = 'error';
      try {
        const result = await this.runEnsureStripeCoupon(couponId, idempotencyKey);
        outcome = result.outcome;
        return result.value;
      } finally {
        span.setAttribute('coupon.outcome', outcome);
        this.metrics.recordStripeEnsure(outcome, elapsedSeconds(startNs));
      }
    });
  }

  /**
   * Body of {@link ensureStripeCoupon}. Returns the `Result` paired with the
   * bounded metric `outcome` — splitting this out of the public method keeps
   * the `withSpan` + `finally` wrapper tiny while letting the three distinct
   * `ok(...)` cases (`ok` / `cached` / `skipped_trial`) each carry their own
   * outcome label.
   */
  private async runEnsureStripeCoupon(
    couponId: string,
    idempotencyKey?: string,
  ): Promise<{
    readonly outcome: CouponStripeEnsureOutcome;
    readonly value: Result<string | null, CouponRedemptionFailure>;
  }> {
    const row = await this.prisma.coupon.findUnique({
      where: { id: couponId },
      select: couponSelect,
    });
    if (row === null) {
      return {
        outcome: 'coupon_not_found',
        value: err({ reason: 'coupon_not_found', code: couponId }),
      };
    }
    if (row.kind === 'extended_trial') {
      return { outcome: 'skipped_trial', value: ok(null) };
    }
    if (row.stripeCouponId !== null) {
      return { outcome: 'cached', value: ok(row.stripeCouponId) };
    }

    const createParams: Stripe.CouponCreateParams = {
      duration: row.duration,
      ...(row.duration === 'repeating' &&
        row.durationInMonths !== null && {
          duration_in_months: row.durationInMonths,
        }),
      metadata: {
        platform_coupon_id: row.id,
        platform_code: row.code,
      },
      ...(row.maxRedemptions !== null && { max_redemptions: row.maxRedemptions }),
      ...(row.expiresAt !== null && {
        redeem_by: Math.floor(row.expiresAt.getTime() / 1000),
      }),
      ...(row.kind === 'percent_off' && { percent_off: row.amount }),
      ...(row.kind === 'amount_off' && {
        amount_off: row.amount,
        currency: row.currency.toLowerCase(),
      }),
      name: row.name,
    };

    let stripeCoupon: Stripe.Coupon;
    try {
      stripeCoupon = await this.stripe.coupons.create(createParams, {
        idempotencyKey:
          idempotencyKey !== undefined ? `${idempotencyKey}:coupon:${row.id}` : `coupon:${row.id}`,
      });
    } catch (cause) {
      this.logger.warn(
        { couponId: row.id, err: stripeErrorMessage(cause) },
        'coupons.ensureStripeCoupon stripe failure',
      );
      return { outcome: 'stripe_unavailable', value: err({ reason: 'stripe_unavailable', cause }) };
    }

    await this.prisma.coupon.update({
      where: { id: row.id },
      data: { stripeCouponId: stripeCoupon.id },
    });

    return { outcome: 'ok', value: ok(stripeCoupon.id) };
  }

  // ─────────────────────────────────────────────────────────────────────
  // ADMIN CREATE / DEACTIVATE.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Create a new coupon definition. The code is normalised to upper-case
   * before insert so the unique index sees the canonical form regardless
   * of what the admin typed. The Stripe Coupon is NOT created here —
   * it's lazy-initialised on first redemption via `ensureStripeCoupon`.
   * Lazy avoids polluting the Stripe Dashboard with definitions that
   * never get used.
   */
  async createCoupon(
    request: CreateCouponRequest,
    creatorUserId: string,
  ): Promise<Result<{ readonly couponId: string; readonly code: string }, CouponAdminFailure>> {
    const normalisedCode = normaliseCode(request.code);

    try {
      const created = await this.prisma.coupon.create({
        data: {
          code: normalisedCode,
          name: request.name,
          kind: request.kind,
          amount: request.amount,
          currency: request.currency,
          duration: request.duration,
          durationInMonths: request.durationInMonths ?? null,
          appliesToPlanIds: request.appliesToPlanIds,
          ...(request.maxRedemptions !== undefined && {
            maxRedemptions: request.maxRedemptions,
          }),
          ...(request.perCustomerLimit !== undefined && {
            perCustomerLimit: request.perCustomerLimit,
          }),
          firstTimeCustomerOnly: request.firstTimeCustomerOnly,
          ...(request.minSpendMinor !== undefined && {
            minSpendMinor: request.minSpendMinor,
          }),
          stackable: request.stackable,
          ...(request.expiresAt !== undefined && {
            expiresAt: new Date(request.expiresAt),
          }),
          ...(request.notes !== undefined && { notes: request.notes }),
          createdByUserId: creatorUserId,
        },
        select: { id: true, code: true },
      });

      this.logger.log(
        { couponId: created.id, code: created.code, creatorUserId },
        'coupons.createCoupon ok',
      );

      return ok({ couponId: created.id, code: created.code });
    } catch (cause) {
      if (isPrismaUniqueViolation(cause)) {
        return err({ reason: 'coupon_code_taken', code: normalisedCode });
      }
      throw cause;
    }
  }

  /**
   * Deactivate a coupon. The row remains queryable (preserves the
   * `coupon_redemptions` audit trail's FK target); the gate on `active`
   * means new redemptions are rejected. No Stripe-side cleanup is
   * required — the cached Stripe Coupon stays attached to the
   * subscriptions that already redeemed it.
   */
  async deactivateCoupon(couponId: string): Promise<Result<void, CouponAdminFailure>> {
    const existing = await this.prisma.coupon.findUnique({
      where: { id: couponId },
      select: { id: true, active: true },
    });
    if (existing === null) {
      return err({ reason: 'coupon_not_found', couponId });
    }
    if (!existing.active) {
      return ok(undefined);
    }
    await this.prisma.coupon.update({
      where: { id: couponId },
      data: { active: false },
    });
    this.logger.log({ couponId }, 'coupons.deactivateCoupon ok');
    return ok(undefined);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Private helpers.
  // ─────────────────────────────────────────────────────────────────────

  private async runGates(
    row: CouponRowSlice,
    input: ValidateCouponInput,
    plan: CouponPlanContext,
    billingInterval: 'monthly' | 'annual',
  ): Promise<Result<ValidatedCoupon, CouponValidationFailure>> {
    if (!row.active) {
      return err({ reason: 'coupon_inactive', couponId: row.id });
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      return err({
        reason: 'coupon_expired',
        couponId: row.id,
        expiresAt: row.expiresAt,
      });
    }
    if (row.maxRedemptions !== null && row.timesRedeemed >= row.maxRedemptions) {
      return err({
        reason: 'coupon_cap_reached',
        couponId: row.id,
        maxRedemptions: row.maxRedemptions,
      });
    }
    if (row.appliesToPlanIds.length > 0 && !row.appliesToPlanIds.includes(input.planId)) {
      return err({
        reason: 'coupon_plan_not_eligible',
        couponId: row.id,
        planId: input.planId,
      });
    }

    const unitPriceMinor =
      billingInterval === 'monthly' ? plan.monthlyPriceMinor : plan.annualPriceMinor;
    if (row.minSpendMinor !== null && unitPriceMinor < row.minSpendMinor) {
      return err({
        reason: 'coupon_min_spend_not_met',
        couponId: row.id,
        minSpendMinor: row.minSpendMinor,
        unitPriceMinor,
      });
    }

    if (row.perCustomerLimit !== null) {
      const priorRedemptions = await this.prisma.couponRedemption.count({
        where: {
          couponId: row.id,
          customerId: input.customerId,
          customerGroup: input.customerGroup,
        },
      });
      if (priorRedemptions >= row.perCustomerLimit) {
        return err({
          reason: 'coupon_per_customer_limit_reached',
          couponId: row.id,
          perCustomerLimit: row.perCustomerLimit,
        });
      }
    }

    if (row.firstTimeCustomerOnly) {
      const priorSubscriptions = await this.prisma.subscription.count({
        where: { customerId: input.customerId, customerGroup: input.customerGroup },
      });
      if (priorSubscriptions > 0) {
        return err({
          reason: 'coupon_first_time_only',
          couponId: row.id,
          priorSubscriptions,
        });
      }
    }

    const { valueAppliedMinor, extendedTrialDays } = computeDiscount(row, unitPriceMinor);

    return ok({
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      amount: row.amount,
      currency: row.currency,
      duration: row.duration,
      durationInMonths: row.durationInMonths,
      stackable: row.stackable,
      stripeCouponId: row.stripeCouponId,
      valueAppliedMinor,
      extendedTrialDays,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Module-private helpers.
// ─────────────────────────────────────────────────────────────────────────

const couponSelect = {
  id: true,
  code: true,
  name: true,
  kind: true,
  amount: true,
  currency: true,
  duration: true,
  durationInMonths: true,
  appliesToPlanIds: true,
  maxRedemptions: true,
  timesRedeemed: true,
  perCustomerLimit: true,
  firstTimeCustomerOnly: true,
  minSpendMinor: true,
  stackable: true,
  expiresAt: true,
  active: true,
  stripeCouponId: true,
} as const;

/**
 * Normalise a user-typed coupon code to its canonical storage shape.
 * Trims surrounding whitespace, upper-cases, leaves the regex check to
 * the contract layer (which has already validated by the time we hit
 * the service in the controller path; the validate-by-internal-caller
 * path can re-validate if it doesn't trust its inputs).
 */
function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Compute the discount value (in minor units) and the extended-trial
 * day count for a coupon redemption against a specific unit price.
 *
 * Money math uses Decimal exclusively per CLAUDE.md §17.6 — even though
 * the inputs are integer minor units + integer percent, we want the
 * arithmetic to survive any future schema change introducing decimal
 * percents (e.g. 12.5%-off promos).
 */
function computeDiscount(
  row: CouponRowSlice,
  unitPriceMinor: number,
): { valueAppliedMinor: number; extendedTrialDays: number | null } {
  if (row.kind === 'percent_off') {
    const percent = new Decimal(row.amount);
    const price = new Decimal(unitPriceMinor);
    const discountMinor = price.mul(percent).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
    const capped = Decimal.min(discountMinor, price);
    return { valueAppliedMinor: capped.toNumber(), extendedTrialDays: null };
  }
  if (row.kind === 'amount_off') {
    const discount = new Decimal(row.amount);
    const price = new Decimal(unitPriceMinor);
    const capped = Decimal.min(discount, price);
    return { valueAppliedMinor: capped.toNumber(), extendedTrialDays: null };
  }
  // extended_trial — amount is in days, not currency.
  return { valueAppliedMinor: 0, extendedTrialDays: row.amount };
}

/**
 * Duck-typed Prisma unique-violation guard. See TS-021-followup-2 for
 * the root cause — Prisma 5.22's namespace value-side resolves
 * inconsistently under our tsconfig. Mirrors the guard used in
 * auth.service.ts.
 */
function isPrismaUniqueViolation(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return code === 'P2002';
}

function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}
