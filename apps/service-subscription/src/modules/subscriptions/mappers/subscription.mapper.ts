import type {
  BillingInterval,
  PlanCustomerGroup,
  SubscriptionCancelReason,
  SubscriptionResponse,
  SubscriptionStatus,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

/**
 * The in-service shape the SubscriptionsService hands to the DTO mapper.
 * Decoupled from the Prisma row so the mapper can be exercised in tests
 * without spinning up a Prisma client + Decimal proxy.
 *
 * `unitPriceDecimal` is the per-period price (already reflecting the
 * chosen billingInterval); the mapper converts to integer minor units
 * via Decimal — never `Number` (CLAUDE.md §17.6).
 */
export interface SubscriptionDtoSource {
  readonly id: string;
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly customerId: string;
  readonly customerGroup: PlanCustomerGroup;
  readonly planId: string;
  readonly planCode: string;
  readonly status: SubscriptionStatus;
  readonly billingInterval: BillingInterval;
  readonly unitPriceDecimal: Decimal;
  readonly currency: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelReason: SubscriptionCancelReason | null;
  readonly canceledAt: Date | null;
  /** TS-042 dunning state — see schema doc-comments. */
  readonly dunningAttempts: number;
  readonly dunningLastAttemptAt: Date | null;
  readonly dunningGraceUntil: Date | null;
  /** TS-042 pause state — see schema doc-comments. */
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Convert the in-service shape to the over-the-wire DTO. The single
 * place money + dates cross from Decimal/Date to integer/string.
 */
export function toSubscriptionResponse(source: SubscriptionDtoSource): SubscriptionResponse {
  return {
    id: source.id,
    stripeSubscriptionId: source.stripeSubscriptionId,
    stripeCustomerId: source.stripeCustomerId,
    customerId: source.customerId,
    customerGroup: source.customerGroup,
    planId: source.planId,
    planCode: source.planCode,
    status: source.status,
    billingInterval: source.billingInterval,
    unitPriceUsdMinor: decimalToUsdMinor(source.unitPriceDecimal),
    currency: narrowCurrency(source.currency),
    currentPeriodStart: source.currentPeriodStart.toISOString(),
    currentPeriodEnd: source.currentPeriodEnd.toISOString(),
    trialEnd: source.trialEnd !== null ? source.trialEnd.toISOString() : null,
    cancelAtPeriodEnd: source.cancelAtPeriodEnd,
    cancelReason: source.cancelReason,
    canceledAt: source.canceledAt !== null ? source.canceledAt.toISOString() : null,
    dunningAttempts: source.dunningAttempts,
    dunningLastAttemptAt:
      source.dunningLastAttemptAt !== null ? source.dunningLastAttemptAt.toISOString() : null,
    dunningGraceUntil:
      source.dunningGraceUntil !== null ? source.dunningGraceUntil.toISOString() : null,
    pauseCollectionStartedAt:
      source.pauseCollectionStartedAt !== null
        ? source.pauseCollectionStartedAt.toISOString()
        : null,
    pauseCollectionResumesAt:
      source.pauseCollectionResumesAt !== null
        ? source.pauseCollectionResumesAt.toISOString()
        : null,
    pauseReason: source.pauseReason,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

/**
 * Convert a Decimal price (e.g. 199.00) to integer USD minor units
 * (e.g. 19900) WITHOUT going through `Number` (CLAUDE.md §17.6).
 *
 * The two-step is: round to 2 decimal places (defence-in-depth — the
 * column is `Decimal(12,2)` so this should be a no-op), then multiply
 * by 100 and convert to a JS integer. The result is bounded by the
 * column type to ≤ 999_999_999_999 minor units, comfortably inside
 * `Number.MAX_SAFE_INTEGER` (~9.0e15).
 */
function decimalToUsdMinor(value: Decimal): number {
  return value
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}

/**
 * Narrow the DB-side `currency CHAR(3)` to the contract enum (USD only
 * in Phase 1). A row carrying a future currency would surface a clean
 * 500 here rather than silently passing through unsupported wire shape.
 * Mirrors the discipline in `PlansService.narrowCurrency`.
 */
function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`unsupported currency in subscription row: ${value}`);
  }
  return 'USD';
}
