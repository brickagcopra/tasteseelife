import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local enum mirrors. Same TS-021-followup-2 / -3 / TS-026-followup-5
 * root cause — Prisma 5.22's namespace value-side resolves
 * inconsistently under our tsconfig, so services use locally-declared
 * string-literal unions for the generated enums. The cross-pin is the
 * contract-side `SubscriptionStatusSchema` + `PlanCustomerGroupSchema`;
 * drift surfaces at the first call that passes a non-listed string to
 * Prisma. Replaced once Prisma 5.23 / 6.x resolves the namespace cleanly
 * (TS-127-followup local-mirror cleanup item).
 */
type SubscriptionStatusValue =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'paused';

type CustomerGroupValue = 'family' | 'provider' | 'academy';

type BillingIntervalValue = 'monthly' | 'annual';

type CancelReasonValue =
  | 'customer_request'
  | 'payment_failure'
  | 'fraud'
  | 'admin_action'
  | 'partner_termination';

type SubscriptionHistoryEventValue =
  | 'created'
  | 'status_changed'
  | 'plan_changed'
  | 'payment_method_changed'
  | 'trial_extended'
  | 'paused'
  | 'resumed'
  | 'canceled'
  | 'reactivated';

type PaymentMethodKindValue = 'card' | 'bank_account';

/**
 * Hard cap on the history slice returned with each detail response.
 * Matches the contract's `ADMIN_SUBSCRIPTIONS_HISTORY_MAX`; pinned here
 * as a constant so the service can apply the cap without importing the
 * contract module (avoids cycles).
 */
const HISTORY_LIMIT = 50;

/**
 * Service-layer row shape for the list response. Carries the denormalised
 * plan code + name + unit price so the list endpoint doesn't N+1-fetch.
 */
export interface AdminSubscriptionListRow {
  readonly id: string;
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly customerId: string;
  readonly customerGroup: CustomerGroupValue;
  readonly planId: string;
  readonly planCode: string;
  readonly planName: string;
  readonly status: SubscriptionStatusValue;
  readonly billingInterval: BillingIntervalValue;
  /** Integer USD minor units for the chosen interval. */
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelReason: CancelReasonValue | null;
  readonly canceledAt: Date | null;
  /** Derived: in dunning grace at the call instant. */
  readonly inDunningGrace: boolean;
  /** Derived: paused at the call instant. */
  readonly isPaused: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminSubscriptionListPage {
  readonly subscriptions: readonly AdminSubscriptionListRow[];
  readonly nextCursor: string | null;
}

export interface AdminSubscriptionPlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly customerGroup: CustomerGroupValue;
  readonly monthlyPriceMinor: number;
  readonly annualPriceMinor: number;
  readonly currency: string;
  readonly active: boolean;
}

export interface AdminSubscriptionPaymentMethodRow {
  readonly id: string;
  readonly stripePaymentMethodId: string;
  readonly kind: PaymentMethodKindValue;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expiryMonth: number | null;
  readonly expiryYear: number | null;
  readonly isDefault: boolean;
}

export interface AdminSubscriptionDunningRow {
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly graceUntil: Date | null;
  readonly inGracePeriod: boolean;
}

export interface AdminSubscriptionPauseRow {
  readonly isPaused: boolean;
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
}

export interface AdminSubscriptionHistoryRow {
  readonly id: string;
  readonly event: SubscriptionHistoryEventValue;
  readonly fromStatus: SubscriptionStatusValue | null;
  readonly toStatus: SubscriptionStatusValue | null;
  readonly context: Record<string, unknown>;
  readonly actorUserId: string | null;
  readonly actorKind: 'user' | 'admin' | 'system';
  readonly source: string | null;
  readonly occurredAt: Date;
}

export interface AdminSubscriptionDetailRow {
  readonly id: string;
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly customerId: string;
  readonly customerGroup: CustomerGroupValue;
  readonly status: SubscriptionStatusValue;
  readonly billingInterval: BillingIntervalValue;
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelReason: CancelReasonValue | null;
  readonly canceledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly plan: AdminSubscriptionPlanRow;
  readonly defaultPaymentMethod: AdminSubscriptionPaymentMethodRow | null;
  readonly dunning: AdminSubscriptionDunningRow;
  readonly pause: AdminSubscriptionPauseRow;
  readonly history: readonly AdminSubscriptionHistoryRow[];
}

export interface ListSubscriptionsInput {
  readonly customerGroup?: CustomerGroupValue | undefined;
  readonly status?: SubscriptionStatusValue | undefined;
  readonly planId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly now?: Date | undefined;
}

export interface GetSubscriptionByIdInput {
  readonly subscriptionId: string;
  readonly now?: Date | undefined;
}

/**
 * Admin subscriptions management service (TS-127 Slice 1).
 *
 * Owns the read-only `GET /api/v1/admin/subscriptions` and
 * `GET /api/v1/admin/subscriptions/:id` surfaces. Both endpoints are
 * gated upstream by `AccessTokenGuard` + `SuperAdminRoleGuard`; this
 * service does NOT re-check authorisation — it trusts the controller
 * layer to have done so.
 *
 * **Cursor pagination.** Opaque base64-encoded `{createdAt-ISO, id}`
 * pair. Server-side fixed ordering: `createdAt DESC, id DESC` (newest
 * first). Stable secondary sort on `id` so equal-`createdAt` rows page
 * deterministically. Mirrors the TS-126 AdminUsersService shape so admin
 * tooling has one cursor codec across surfaces.
 *
 * **Filter shape.** Every filter is exact-match — customerGroup, status,
 * planId, customerId. Substring-on-customer-id is intentionally absent
 * (the customer id is a soft FK; ops staff search via the household or
 * provider portals first, then drill into subscriptions from there).
 *
 * **Denormalisation.** The list response carries `planCode` + `planName`
 * per row so the list page renders without an N+1 detail fetch. Computed
 * via a single `plan.findMany` call across the page's plan ids (one
 * Prisma round-trip), joined in-process.
 *
 * **Money math.** Prisma returns `Decimal` for the price columns; the
 * service converts to integer minor units via `decimal.js` (`× 100`,
 * rounded — but the source data is already at 2 decimal places so the
 * round is a defensive no-op). Never `Number` math on money
 * (CLAUDE.md §17.6).
 *
 * **`now` injection.** The "derived" flags (`inDunningGrace`, `isPaused`)
 * use the request's wall-clock instant by default; tests inject a fixed
 * `Date` for deterministic assertions.
 */
@Injectable()
export class AdminSubscriptionsService {
  private readonly logger = new Logger(AdminSubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(input: ListSubscriptionsInput): Promise<AdminSubscriptionListPage> {
    const now = input.now ?? new Date();
    const limit = clampLimit(input.limit);
    const decoded = decodeCursor(input.cursor);

    // The where-clause shape under conditional spread defeats Prisma's
    // inferred return type, so we pin the select shape here and let the
    // local annotation flow through.
    type SubscriptionListPrismaRow = {
      readonly id: string;
      readonly stripeSubscriptionId: string;
      readonly stripeCustomerId: string;
      readonly customerId: string;
      readonly customerGroup: CustomerGroupValue;
      readonly planId: string;
      readonly status: SubscriptionStatusValue;
      readonly billingInterval: BillingIntervalValue;
      readonly currentPeriodStart: Date;
      readonly currentPeriodEnd: Date;
      readonly trialEnd: Date | null;
      readonly cancelAtPeriodEnd: boolean;
      readonly cancelReason: CancelReasonValue | null;
      readonly canceledAt: Date | null;
      readonly dunningGraceUntil: Date | null;
      readonly pauseCollectionStartedAt: Date | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    };

    const where = {
      ...(input.customerGroup !== undefined ? { customerGroup: input.customerGroup } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(decoded !== null
        ? {
            // Keyset pagination: `(createdAt, id)` strictly LESS than
            // the cursor's `(createdAt, id)` under DESC ordering.
            OR: [
              { createdAt: { lt: decoded.createdAt } },
              {
                AND: [{ createdAt: decoded.createdAt }, { id: { lt: decoded.id } }],
              },
            ],
          }
        : {}),
    };

    const rows: SubscriptionListPrismaRow[] = await this.prisma.subscription.findMany({
      where,
      select: {
        id: true,
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        customerId: true,
        customerGroup: true,
        planId: true,
        status: true,
        billingInterval: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        trialEnd: true,
        cancelAtPeriodEnd: true,
        cancelReason: true,
        canceledAt: true,
        dunningGraceUntil: true,
        pauseCollectionStartedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;

    // Bulk-fetch the matching plan rows in one round-trip so the list
    // page can render plan code + name + unit price without N+1.
    const planIds = Array.from(new Set(trimmed.map((r) => r.planId)));
    const planSummaries = await this.findPlanSummaries(planIds);

    const subscriptions: AdminSubscriptionListRow[] = trimmed.map(
      (row): AdminSubscriptionListRow => {
        const plan = planSummaries.get(row.planId);
        const unitPriceMinor =
          plan === undefined ? 0 : pickUnitPriceMinor(plan, row.billingInterval);
        return {
          id: row.id,
          stripeSubscriptionId: row.stripeSubscriptionId,
          stripeCustomerId: row.stripeCustomerId,
          customerId: row.customerId,
          customerGroup: row.customerGroup,
          planId: row.planId,
          planCode: plan?.code ?? 'unknown',
          planName: plan?.name ?? 'unknown',
          status: row.status,
          billingInterval: row.billingInterval,
          unitPriceMinor,
          currency: plan?.currency ?? 'USD',
          currentPeriodStart: row.currentPeriodStart,
          currentPeriodEnd: row.currentPeriodEnd,
          trialEnd: row.trialEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          cancelReason: row.cancelReason,
          canceledAt: row.canceledAt,
          inDunningGrace: computeInDunningGrace(row.status, row.dunningGraceUntil, now),
          isPaused: computeIsPaused(row.status, row.pauseCollectionStartedAt),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      },
    );

    this.logger.log(
      {
        actorId: '<admin>',
        resultCount: subscriptions.length,
        hasMore,
        filters: {
          customerGroup: input.customerGroup ?? null,
          status: input.status ?? null,
          planId: input.planId ?? null,
          customerId: input.customerId ?? null,
        },
      },
      'admin.subscriptions.list',
    );

    return { subscriptions, nextCursor };
  }

  async getById(input: GetSubscriptionByIdInput): Promise<AdminSubscriptionDetailRow | null> {
    const now = input.now ?? new Date();

    type SubscriptionDetailPrismaRow = {
      readonly id: string;
      readonly stripeSubscriptionId: string;
      readonly stripeCustomerId: string;
      readonly customerId: string;
      readonly customerGroup: CustomerGroupValue;
      readonly planId: string;
      readonly status: SubscriptionStatusValue;
      readonly billingInterval: BillingIntervalValue;
      readonly currentPeriodStart: Date;
      readonly currentPeriodEnd: Date;
      readonly trialEnd: Date | null;
      readonly cancelAtPeriodEnd: boolean;
      readonly cancelReason: CancelReasonValue | null;
      readonly canceledAt: Date | null;
      readonly defaultPaymentMethodId: string | null;
      readonly dunningAttempts: number;
      readonly dunningLastAttemptAt: Date | null;
      readonly dunningGraceUntil: Date | null;
      readonly pauseCollectionStartedAt: Date | null;
      readonly pauseCollectionResumesAt: Date | null;
      readonly pauseReason: string | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    };

    const subscription: SubscriptionDetailPrismaRow | null =
      await this.prisma.subscription.findUnique({
        where: { id: input.subscriptionId },
        select: {
          id: true,
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          customerId: true,
          customerGroup: true,
          planId: true,
          status: true,
          billingInterval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          trialEnd: true,
          cancelAtPeriodEnd: true,
          cancelReason: true,
          canceledAt: true,
          defaultPaymentMethodId: true,
          dunningAttempts: true,
          dunningLastAttemptAt: true,
          dunningGraceUntil: true,
          pauseCollectionStartedAt: true,
          pauseCollectionResumesAt: true,
          pauseReason: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    if (subscription === null) return null;

    // Three parallel reads — plan summary, default payment method (if
    // any), and the history slice. Plan is required (FK-enforced at the
    // DB), so a null return means a schema-drift bug; we throw a
    // defensive Logger.error and fall back to a "unknown" placeholder.
    type PlanPrismaRow = {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly customerGroup: CustomerGroupValue;
      readonly monthlyPrice: Decimal;
      readonly annualPrice: Decimal;
      readonly currency: string;
      readonly active: boolean;
    };
    type PaymentMethodPrismaRow = {
      readonly id: string;
      readonly stripePaymentMethodId: string;
      readonly kind: PaymentMethodKindValue;
      readonly brand: string | null;
      readonly last4: string | null;
      readonly expiryMonth: number | null;
      readonly expiryYear: number | null;
      readonly isDefault: boolean;
    };
    type HistoryPrismaRow = {
      readonly id: string;
      readonly event: SubscriptionHistoryEventValue;
      readonly fromStatus: SubscriptionStatusValue | null;
      readonly toStatus: SubscriptionStatusValue | null;
      readonly context: unknown;
      readonly actorUserId: string | null;
      readonly actorKind: string;
      readonly source: string | null;
      readonly occurredAt: Date;
    };

    const [planRow, paymentMethodRow, historyRows]: [
      PlanPrismaRow | null,
      PaymentMethodPrismaRow | null,
      HistoryPrismaRow[],
    ] = await Promise.all([
      this.prisma.plan.findUnique({
        where: { id: subscription.planId },
        select: {
          id: true,
          code: true,
          name: true,
          customerGroup: true,
          monthlyPrice: true,
          annualPrice: true,
          currency: true,
          active: true,
        },
      }) as Promise<PlanPrismaRow | null>,
      subscription.defaultPaymentMethodId !== null
        ? (this.prisma.paymentMethod.findUnique({
            where: { id: subscription.defaultPaymentMethodId },
            select: {
              id: true,
              stripePaymentMethodId: true,
              kind: true,
              brand: true,
              last4: true,
              expiryMonth: true,
              expiryYear: true,
              isDefault: true,
            },
          }) as Promise<PaymentMethodPrismaRow | null>)
        : Promise.resolve(null),
      this.prisma.subscriptionHistory.findMany({
        where: { subscriptionId: subscription.id },
        select: {
          id: true,
          event: true,
          fromStatus: true,
          toStatus: true,
          context: true,
          actorUserId: true,
          actorKind: true,
          source: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: HISTORY_LIMIT,
      }) as Promise<HistoryPrismaRow[]>,
    ]);

    if (planRow === null) {
      this.logger.error(
        { subscriptionId: subscription.id, planId: subscription.planId },
        'admin.subscriptions.detail.plan_missing',
      );
    }

    const planSummary: AdminSubscriptionPlanRow =
      planRow !== null
        ? planRowToSummary(planRow)
        : {
            id: subscription.planId,
            code: 'unknown',
            name: 'unknown',
            customerGroup: subscription.customerGroup,
            monthlyPriceMinor: 0,
            annualPriceMinor: 0,
            currency: 'USD',
            active: false,
          };

    const unitPriceMinor =
      planRow !== null
        ? pickUnitPriceMinor(planRowToSummary(planRow), subscription.billingInterval)
        : 0;

    const defaultPaymentMethod: AdminSubscriptionPaymentMethodRow | null =
      paymentMethodRow !== null
        ? {
            id: paymentMethodRow.id,
            stripePaymentMethodId: paymentMethodRow.stripePaymentMethodId,
            kind: paymentMethodRow.kind,
            brand: paymentMethodRow.brand,
            last4: paymentMethodRow.last4,
            expiryMonth: paymentMethodRow.expiryMonth,
            expiryYear: paymentMethodRow.expiryYear,
            isDefault: paymentMethodRow.isDefault,
          }
        : null;

    const dunning: AdminSubscriptionDunningRow = {
      attempts: subscription.dunningAttempts,
      lastAttemptAt: subscription.dunningLastAttemptAt,
      graceUntil: subscription.dunningGraceUntil,
      inGracePeriod: computeInDunningGrace(
        subscription.status,
        subscription.dunningGraceUntil,
        now,
      ),
    };

    const pause: AdminSubscriptionPauseRow = {
      isPaused: computeIsPaused(subscription.status, subscription.pauseCollectionStartedAt),
      pauseCollectionStartedAt: subscription.pauseCollectionStartedAt,
      pauseCollectionResumesAt: subscription.pauseCollectionResumesAt,
      pauseReason: subscription.pauseReason,
    };

    const history: AdminSubscriptionHistoryRow[] = historyRows.map(
      (h): AdminSubscriptionHistoryRow => {
        const context =
          h.context !== null && typeof h.context === 'object' && !Array.isArray(h.context)
            ? (h.context as Record<string, unknown>)
            : {};
        return {
          id: h.id,
          event: h.event,
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          context,
          actorUserId: h.actorUserId,
          actorKind: normaliseActorKind(h.actorKind),
          source: h.source,
          occurredAt: h.occurredAt,
        };
      },
    );

    this.logger.log(
      { actorId: '<admin>', targetSubscriptionId: subscription.id },
      'admin.subscriptions.detail',
    );

    return {
      id: subscription.id,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeCustomerId: subscription.stripeCustomerId,
      customerId: subscription.customerId,
      customerGroup: subscription.customerGroup,
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      unitPriceMinor,
      currency: planSummary.currency,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEnd: subscription.trialEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      cancelReason: subscription.cancelReason,
      canceledAt: subscription.canceledAt,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      plan: planSummary,
      defaultPaymentMethod,
      dunning,
      pause,
      history,
    };
  }

  /**
   * Bulk-fetch plan summaries for a list of plan ids. Returns a Map
   * keyed by planId. One Prisma call across all ids; the list endpoint
   * uses it to avoid N+1 plan reads.
   */
  private async findPlanSummaries(
    planIds: readonly string[],
  ): Promise<Map<string, AdminSubscriptionPlanRow>> {
    const out = new Map<string, AdminSubscriptionPlanRow>();
    if (planIds.length === 0) return out;

    type PlanPrismaRow = {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly customerGroup: CustomerGroupValue;
      readonly monthlyPrice: Decimal;
      readonly annualPrice: Decimal;
      readonly currency: string;
      readonly active: boolean;
    };

    const rows: PlanPrismaRow[] = (await this.prisma.plan.findMany({
      where: { id: { in: [...planIds] } },
      select: {
        id: true,
        code: true,
        name: true,
        customerGroup: true,
        monthlyPrice: true,
        annualPrice: true,
        currency: true,
        active: true,
      },
    })) as PlanPrismaRow[];

    for (const row of rows) {
      out.set(row.id, planRowToSummary(row));
    }
    return out;
  }
}

/**
 * Convert a Prisma plan row to the service-layer plan summary,
 * collapsing the Decimal columns into integer USD minor units via
 * `decimal.js` (never Number math on money — CLAUDE.md §17.6).
 */
function planRowToSummary(row: {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly customerGroup: CustomerGroupValue;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
  readonly currency: string;
  readonly active: boolean;
}): AdminSubscriptionPlanRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    customerGroup: row.customerGroup,
    monthlyPriceMinor: decimalToMinor(row.monthlyPrice),
    annualPriceMinor: decimalToMinor(row.annualPrice),
    currency: row.currency,
    active: row.active,
  };
}

function decimalToMinor(value: Decimal): number {
  // Plan prices land as `Decimal(12,2)` — `× 100` yields an integer
  // minor-unit value with zero rounding error. `toNumber()` is safe
  // because the result fits in a 32-bit signed int (max plan price
  // bounded by `Decimal(12,2)` — 999,999,999.99 → 99,999,999,999 minor
  // units, which exceeds Number.MAX_SAFE_INTEGER's headroom for
  // multi-billion-dollar accumulations but is fine per single plan).
  return value.mul(100).toNumber();
}

function pickUnitPriceMinor(
  plan: AdminSubscriptionPlanRow,
  interval: BillingIntervalValue,
): number {
  return interval === 'monthly' ? plan.monthlyPriceMinor : plan.annualPriceMinor;
}

/**
 * Derive the "in dunning grace" flag from the persisted columns. The
 * Phase-1 policy is:
 *
 *   `status === 'past_due' && graceUntil !== null && graceUntil > now`
 *
 * Captures the active retry-window only; a row in `past_due` whose
 * graceUntil has already passed (waiting for the sweeper to flip to
 * `unpaid`) returns `false`.
 */
function computeInDunningGrace(
  status: SubscriptionStatusValue,
  graceUntil: Date | null,
  now: Date,
): boolean {
  if (status !== 'past_due') return false;
  if (graceUntil === null) return false;
  return graceUntil.getTime() > now.getTime();
}

/**
 * Derive the "is currently paused" flag. Catches both the canonical
 * platform status `paused` AND the Stripe-side `pause_collection` window
 * (set on the row even when the platform status hasn't moved yet, e.g.
 * during a pause-flow that crashed before the status flip).
 */
function computeIsPaused(
  status: SubscriptionStatusValue,
  pauseCollectionStartedAt: Date | null,
): boolean {
  return status === 'paused' || pauseCollectionStartedAt !== null;
}

/**
 * Persist-layer `actor_kind` is a free-form text column; the service
 * normalises to the closed-union contract enum. Unknown values fall back
 * to `system` (the safest default — system entries can be any non-human
 * caller).
 */
function normaliseActorKind(raw: string): 'user' | 'admin' | 'system' {
  if (raw === 'user' || raw === 'admin' || raw === 'system') return raw;
  return 'system';
}

function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 25;
  if (requested > 100) return 100;
  return Math.floor(requested);
}

/**
 * Cursor codec: base64url of `${createdAtIso}|${id}`. Mirrors the codec
 * in service-identity's AdminUsersService so admin tooling has one shape
 * across surfaces.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  const payload = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (raw === undefined) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const pipe = decoded.indexOf('|');
    if (pipe < 0) return null;
    const iso = decoded.slice(0, pipe);
    const id = decoded.slice(pipe + 1);
    if (id.length === 0) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
