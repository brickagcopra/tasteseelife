import type {
  AdminSubscriptionDetail,
  AdminSubscriptionDunningSummary,
  AdminSubscriptionHistoryEntry,
  AdminSubscriptionPauseSummary,
  AdminSubscriptionPaymentMethodSummary,
  AdminSubscriptionPlanSummary,
  AdminSubscriptionSummary,
  PlanCurrency,
} from '@taste-and-see/contracts';

import type {
  AdminSubscriptionDetailRow,
  AdminSubscriptionDunningRow,
  AdminSubscriptionHistoryRow,
  AdminSubscriptionListRow,
  AdminSubscriptionPauseRow,
  AdminSubscriptionPaymentMethodRow,
  AdminSubscriptionPlanRow,
} from '../services/admin-subscriptions.service';

/**
 * Project the service-layer row shapes onto the contract DTO shapes
 * (TS-127 Slice 1).
 *
 * Mirrors `admin-user.mapper.ts` (TS-126) — lives at the controller
 * boundary so the controllers never return raw Prisma rows or
 * service-internal structures (CLAUDE.md §3.3: "All outbound responses
 * pass through DTO mappers — never return raw Prisma objects to the
 * client.").
 *
 * Date / Decimal conversion: the service-layer types carry native
 * `Date`s + native numbers (minor units already converted from Decimal
 * upstream — see `decimalToMinor` in admin-subscriptions.service.ts).
 * Mapper just ISO-formats the dates.
 */
export function summaryRowToDto(row: AdminSubscriptionListRow): AdminSubscriptionSummary {
  return {
    id: row.id,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    customerId: row.customerId,
    customerGroup: row.customerGroup,
    planId: row.planId,
    planCode: row.planCode,
    planName: row.planName,
    status: row.status,
    billingInterval: row.billingInterval,
    unitPriceMinor: row.unitPriceMinor,
    currency: narrowCurrency(row.currency),
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    trialEnd: row.trialEnd !== null ? row.trialEnd.toISOString() : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelReason: row.cancelReason,
    canceledAt: row.canceledAt !== null ? row.canceledAt.toISOString() : null,
    inDunningGrace: row.inDunningGrace,
    isPaused: row.isPaused,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function detailRowToDto(row: AdminSubscriptionDetailRow): AdminSubscriptionDetail {
  return {
    id: row.id,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    customerId: row.customerId,
    customerGroup: row.customerGroup,
    status: row.status,
    billingInterval: row.billingInterval,
    unitPriceMinor: row.unitPriceMinor,
    currency: narrowCurrency(row.currency),
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    trialEnd: row.trialEnd !== null ? row.trialEnd.toISOString() : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelReason: row.cancelReason,
    canceledAt: row.canceledAt !== null ? row.canceledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    plan: planRowToDto(row.plan),
    defaultPaymentMethod:
      row.defaultPaymentMethod !== null ? paymentMethodRowToDto(row.defaultPaymentMethod) : null,
    dunning: dunningRowToDto(row.dunning),
    pause: pauseRowToDto(row.pause),
    history: row.history.map(historyRowToDto),
  };
}

function planRowToDto(row: AdminSubscriptionPlanRow): AdminSubscriptionPlanSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    customerGroup: row.customerGroup,
    monthlyPriceMinor: row.monthlyPriceMinor,
    annualPriceMinor: row.annualPriceMinor,
    currency: narrowCurrency(row.currency),
    active: row.active,
  };
}

/**
 * Phase-1 narrowing: `PlanCurrencySchema` is `z.enum(['USD'])` — only
 * USD is permitted. The Prisma column is `Char(3)` (multi-currency-ready
 * per PDD §11.2) so the runtime value is a free-form string. The
 * service-layer rows surface that string verbatim; here at the
 * contract boundary we narrow back to the enum. Non-USD lands as
 * 'USD' defensively (a Phase-1 invariant — a future multi-currency
 * rollout widens `PlanCurrencySchema` rather than relaxing this
 * narrowing).
 */
function narrowCurrency(value: string): PlanCurrency {
  // Single-variant enum until multi-currency lands (PDD §11.2 / TS-420).
  return value === 'USD' ? 'USD' : 'USD';
}

function paymentMethodRowToDto(
  row: AdminSubscriptionPaymentMethodRow,
): AdminSubscriptionPaymentMethodSummary {
  return {
    id: row.id,
    stripePaymentMethodId: row.stripePaymentMethodId,
    kind: row.kind,
    brand: row.brand,
    last4: row.last4,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    isDefault: row.isDefault,
  };
}

function dunningRowToDto(row: AdminSubscriptionDunningRow): AdminSubscriptionDunningSummary {
  return {
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt !== null ? row.lastAttemptAt.toISOString() : null,
    graceUntil: row.graceUntil !== null ? row.graceUntil.toISOString() : null,
    inGracePeriod: row.inGracePeriod,
  };
}

function pauseRowToDto(row: AdminSubscriptionPauseRow): AdminSubscriptionPauseSummary {
  return {
    isPaused: row.isPaused,
    pauseCollectionStartedAt:
      row.pauseCollectionStartedAt !== null ? row.pauseCollectionStartedAt.toISOString() : null,
    pauseCollectionResumesAt:
      row.pauseCollectionResumesAt !== null ? row.pauseCollectionResumesAt.toISOString() : null,
    pauseReason: row.pauseReason,
  };
}

function historyRowToDto(row: AdminSubscriptionHistoryRow): AdminSubscriptionHistoryEntry {
  return {
    id: row.id,
    event: row.event,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    context: row.context,
    actorUserId: row.actorUserId,
    actorKind: row.actorKind,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
  };
}
