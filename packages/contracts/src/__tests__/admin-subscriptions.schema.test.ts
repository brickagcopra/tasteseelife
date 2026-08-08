import { describe, expect, it } from 'vitest';

import {
  ADMIN_SUBSCRIPTIONS_HISTORY_MAX,
  ADMIN_SUBSCRIPTIONS_LIST_LIMIT_DEFAULT,
  ADMIN_SUBSCRIPTIONS_LIST_LIMIT_MAX,
  ADMIN_SUBSCRIPTIONS_PAUSE_REASON_MAX_LENGTH,
  AdminSubscriptionDetailResponseSchema,
  AdminSubscriptionDetailSchema,
  AdminSubscriptionHistoryEntrySchema,
  AdminSubscriptionPaymentMethodSummarySchema,
  AdminSubscriptionSummarySchema,
  AdminSubscriptionsListQuerySchema,
  AdminSubscriptionsListResponseSchema,
  type AdminSubscriptionDetail,
  type AdminSubscriptionHistoryEntry,
  type AdminSubscriptionSummary,
} from '../http/admin-subscriptions.schema';

const NOW_ISO = '2026-05-17T12:00:00.000Z';

const sampleSummary: AdminSubscriptionSummary = {
  id: 'sub_abc',
  stripeSubscriptionId: 'sub_stripe_abc',
  stripeCustomerId: 'cus_abc',
  customerId: 'hh_abc',
  customerGroup: 'family',
  planId: 'plan_tier2',
  planCode: 'family.tier2',
  planName: 'Companion Dining',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceMinor: 29900,
  currency: 'USD',
  currentPeriodStart: NOW_ISO,
  currentPeriodEnd: '2026-06-17T12:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  canceledAt: null,
  inDunningGrace: false,
  isPaused: false,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const sampleHistoryEntry: AdminSubscriptionHistoryEntry = {
  id: 'hist_1',
  event: 'created',
  fromStatus: null,
  toStatus: 'active',
  context: { planCode: 'family.tier2' },
  actorUserId: 'usr_abc',
  actorKind: 'user',
  source: null,
  occurredAt: NOW_ISO,
};

const sampleDetail: AdminSubscriptionDetail = {
  id: 'sub_abc',
  stripeSubscriptionId: 'sub_stripe_abc',
  stripeCustomerId: 'cus_abc',
  customerId: 'hh_abc',
  customerGroup: 'family',
  status: 'active',
  billingInterval: 'monthly',
  unitPriceMinor: 29900,
  currency: 'USD',
  currentPeriodStart: NOW_ISO,
  currentPeriodEnd: '2026-06-17T12:00:00.000Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  canceledAt: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  plan: {
    id: 'plan_tier2',
    code: 'family.tier2',
    name: 'Companion Dining',
    customerGroup: 'family',
    monthlyPriceMinor: 29900,
    annualPriceMinor: 299000,
    currency: 'USD',
    active: true,
  },
  defaultPaymentMethod: {
    id: 'pm_local_1',
    stripePaymentMethodId: 'pm_card_visa',
    kind: 'card',
    brand: 'visa',
    last4: '4242',
    expiryMonth: 12,
    expiryYear: 2030,
    isDefault: true,
  },
  dunning: {
    attempts: 0,
    lastAttemptAt: null,
    graceUntil: null,
    inGracePeriod: false,
  },
  pause: {
    isPaused: false,
    pauseCollectionStartedAt: null,
    pauseCollectionResumesAt: null,
    pauseReason: null,
  },
  history: [sampleHistoryEntry],
};

describe('AdminSubscriptionsListQuerySchema', () => {
  it('returns a fully-defaulted parse when no filters supplied', () => {
    const parsed = AdminSubscriptionsListQuerySchema.parse({});
    expect(parsed.limit).toBe(ADMIN_SUBSCRIPTIONS_LIST_LIMIT_DEFAULT);
    expect(parsed.customerGroup).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.planId).toBeUndefined();
    expect(parsed.customerId).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a numeric-string limit (URL query params arrive as strings)', () => {
    const parsed = AdminSubscriptionsListQuerySchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it('rejects a limit above the bound', () => {
    expect(
      AdminSubscriptionsListQuerySchema.safeParse({
        limit: ADMIN_SUBSCRIPTIONS_LIST_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(AdminSubscriptionsListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AdminSubscriptionsListQuerySchema.safeParse({ limit: -3 }).success).toBe(false);
  });

  it('accepts every PlanCustomerGroup enum value as the customerGroup filter', () => {
    for (const group of ['family', 'provider', 'academy'] as const) {
      const parsed = AdminSubscriptionsListQuerySchema.parse({ customerGroup: group });
      expect(parsed.customerGroup).toBe(group);
    }
  });

  it('rejects an unknown customerGroup value', () => {
    expect(AdminSubscriptionsListQuerySchema.safeParse({ customerGroup: 'mystery' }).success).toBe(
      false,
    );
  });

  it('accepts every SubscriptionStatus enum value as the status filter', () => {
    for (const status of [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'canceled',
      'paused',
    ] as const) {
      const parsed = AdminSubscriptionsListQuerySchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });

  it('rejects an unknown status value', () => {
    expect(AdminSubscriptionsListQuerySchema.safeParse({ status: 'mystery' }).success).toBe(false);
  });

  it('rejects an empty planId / customerId', () => {
    expect(AdminSubscriptionsListQuerySchema.safeParse({ planId: '' }).success).toBe(false);
    expect(AdminSubscriptionsListQuerySchema.safeParse({ customerId: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(AdminSubscriptionsListQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });
});

describe('AdminSubscriptionSummarySchema', () => {
  it('round-trips the sample summary', () => {
    const parsed = AdminSubscriptionSummarySchema.parse(sampleSummary);
    expect(parsed).toEqual(sampleSummary);
  });

  it('rejects a non-integer unitPriceMinor', () => {
    expect(
      AdminSubscriptionSummarySchema.safeParse({ ...sampleSummary, unitPriceMinor: 100.5 }).success,
    ).toBe(false);
  });

  it('rejects a negative unitPriceMinor', () => {
    expect(
      AdminSubscriptionSummarySchema.safeParse({ ...sampleSummary, unitPriceMinor: -1 }).success,
    ).toBe(false);
  });

  it('accepts a null cancelReason + canceledAt for an active sub', () => {
    const parsed = AdminSubscriptionSummarySchema.parse(sampleSummary);
    expect(parsed.cancelReason).toBeNull();
    expect(parsed.canceledAt).toBeNull();
  });

  it('accepts a canceled cancelReason + canceledAt', () => {
    const parsed = AdminSubscriptionSummarySchema.parse({
      ...sampleSummary,
      status: 'canceled',
      cancelReason: 'customer_request',
      canceledAt: NOW_ISO,
    });
    expect(parsed.status).toBe('canceled');
    expect(parsed.cancelReason).toBe('customer_request');
    expect(parsed.canceledAt).toBe(NOW_ISO);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminSubscriptionSummarySchema.safeParse({ ...sampleSummary, extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('AdminSubscriptionsListResponseSchema', () => {
  it('accepts an empty list with no cursor', () => {
    const parsed = AdminSubscriptionsListResponseSchema.parse({
      subscriptions: [],
      nextCursor: null,
    });
    expect(parsed.subscriptions).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a populated list with a non-null cursor', () => {
    const parsed = AdminSubscriptionsListResponseSchema.parse({
      subscriptions: [sampleSummary],
      nextCursor: 'abc123',
    });
    expect(parsed.subscriptions).toHaveLength(1);
    expect(parsed.nextCursor).toBe('abc123');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminSubscriptionsListResponseSchema.safeParse({
        subscriptions: [],
        nextCursor: null,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AdminSubscriptionHistoryEntrySchema', () => {
  it('round-trips a sample history entry', () => {
    const parsed = AdminSubscriptionHistoryEntrySchema.parse(sampleHistoryEntry);
    expect(parsed).toEqual(sampleHistoryEntry);
  });

  it('accepts each history-event kind', () => {
    for (const event of [
      'created',
      'status_changed',
      'plan_changed',
      'payment_method_changed',
      'trial_extended',
      'paused',
      'resumed',
      'canceled',
      'reactivated',
    ] as const) {
      const parsed = AdminSubscriptionHistoryEntrySchema.parse({
        ...sampleHistoryEntry,
        event,
      });
      expect(parsed.event).toBe(event);
    }
  });

  it('rejects an unknown history-event kind', () => {
    expect(
      AdminSubscriptionHistoryEntrySchema.safeParse({
        ...sampleHistoryEntry,
        event: 'mystery',
      }).success,
    ).toBe(false);
  });

  it('accepts each actor kind', () => {
    for (const actorKind of ['user', 'admin', 'system'] as const) {
      const parsed = AdminSubscriptionHistoryEntrySchema.parse({
        ...sampleHistoryEntry,
        actorKind,
      });
      expect(parsed.actorKind).toBe(actorKind);
    }
  });

  it('allows a null actorUserId for system-driven entries', () => {
    const parsed = AdminSubscriptionHistoryEntrySchema.parse({
      ...sampleHistoryEntry,
      actorUserId: null,
      actorKind: 'system',
      source: 'evt_stripe_abc',
    });
    expect(parsed.actorUserId).toBeNull();
    expect(parsed.actorKind).toBe('system');
    expect(parsed.source).toBe('evt_stripe_abc');
  });
});

describe('AdminSubscriptionPaymentMethodSummarySchema', () => {
  it('accepts a fully-populated card method', () => {
    const parsed = AdminSubscriptionPaymentMethodSummarySchema.parse({
      id: 'pm_local_1',
      stripePaymentMethodId: 'pm_card_visa',
      kind: 'card',
      brand: 'visa',
      last4: '4242',
      expiryMonth: 12,
      expiryYear: 2030,
      isDefault: true,
    });
    expect(parsed.last4).toBe('4242');
  });

  it('accepts a bank_account method with nullable card fields', () => {
    const parsed = AdminSubscriptionPaymentMethodSummarySchema.parse({
      id: 'pm_local_2',
      stripePaymentMethodId: 'pm_us_bank_account_1',
      kind: 'bank_account',
      brand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
      isDefault: false,
    });
    expect(parsed.kind).toBe('bank_account');
  });

  it('rejects a last4 not matching /^\\d{4}$/', () => {
    expect(
      AdminSubscriptionPaymentMethodSummarySchema.safeParse({
        id: 'pm_local_1',
        stripePaymentMethodId: 'pm_card_visa',
        kind: 'card',
        brand: 'visa',
        last4: '42',
        expiryMonth: 12,
        expiryYear: 2030,
        isDefault: true,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid expiry month', () => {
    expect(
      AdminSubscriptionPaymentMethodSummarySchema.safeParse({
        id: 'pm_local_1',
        stripePaymentMethodId: 'pm_card_visa',
        kind: 'card',
        brand: 'visa',
        last4: '4242',
        expiryMonth: 13,
        expiryYear: 2030,
        isDefault: true,
      }).success,
    ).toBe(false);
  });
});

describe('AdminSubscriptionDetailSchema', () => {
  it('round-trips the sample detail', () => {
    const parsed = AdminSubscriptionDetailSchema.parse(sampleDetail);
    expect(parsed).toEqual(sampleDetail);
  });

  it('accepts a detail with a null defaultPaymentMethod (incomplete sub)', () => {
    const parsed = AdminSubscriptionDetailSchema.parse({
      ...sampleDetail,
      status: 'incomplete',
      defaultPaymentMethod: null,
    });
    expect(parsed.defaultPaymentMethod).toBeNull();
  });

  it('accepts a detail with an empty history (newly-created sub)', () => {
    const parsed = AdminSubscriptionDetailSchema.parse({
      ...sampleDetail,
      history: [],
    });
    expect(parsed.history).toEqual([]);
  });

  it('caps pauseReason at the documented max length', () => {
    const ok = AdminSubscriptionDetailSchema.parse({
      ...sampleDetail,
      pause: {
        isPaused: true,
        pauseCollectionStartedAt: NOW_ISO,
        pauseCollectionResumesAt: null,
        pauseReason: 'a'.repeat(ADMIN_SUBSCRIPTIONS_PAUSE_REASON_MAX_LENGTH),
      },
    });
    expect(ok.pause.isPaused).toBe(true);
  });

  it('rejects a pauseReason above the documented max length', () => {
    expect(
      AdminSubscriptionDetailSchema.safeParse({
        ...sampleDetail,
        pause: {
          isPaused: true,
          pauseCollectionStartedAt: NOW_ISO,
          pauseCollectionResumesAt: null,
          pauseReason: 'a'.repeat(ADMIN_SUBSCRIPTIONS_PAUSE_REASON_MAX_LENGTH + 1),
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminSubscriptionDetailSchema.safeParse({ ...sampleDetail, extra: 'nope' }).success,
    ).toBe(false);
  });

  it('accepts up to the documented history maximum', () => {
    const history = Array.from({ length: ADMIN_SUBSCRIPTIONS_HISTORY_MAX }, (_, i) => ({
      ...sampleHistoryEntry,
      id: `hist_${i}`,
    }));
    const parsed = AdminSubscriptionDetailSchema.parse({ ...sampleDetail, history });
    expect(parsed.history).toHaveLength(ADMIN_SUBSCRIPTIONS_HISTORY_MAX);
  });
});

describe('AdminSubscriptionDetailResponseSchema', () => {
  it('wraps the detail under a `subscription` key', () => {
    const parsed = AdminSubscriptionDetailResponseSchema.parse({
      subscription: sampleDetail,
    });
    expect(parsed.subscription.id).toBe('sub_abc');
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AdminSubscriptionDetailResponseSchema.safeParse({
        subscription: sampleDetail,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});
