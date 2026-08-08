import { describe, expect, it } from 'vitest';

import {
  CreateAccountLinkRequestSchema,
  CreateAccountLinkResponseSchema,
  CreateConnectAccountRequestSchema,
  CreateConnectAccountResponseSchema,
  IngestStripeAccountEventRequestSchema,
  IngestStripeAccountEventResponseSchema,
  ListPayoutAccountsQuerySchema,
  PAYOUT_LIST_LIMIT_DEFAULT,
  PAYOUT_LIST_LIMIT_MAX,
  PAYOUT_ONBOARDING_URL_MAX_LENGTH,
  PAYOUT_REQUIREMENT_KEY_MAX_LENGTH,
  PAYOUT_REQUIREMENTS_MAX_ENTRIES,
  PayoutAccountLinkKindSchema,
  PayoutAccountResponseSchema,
  PayoutAccountStatusSchema,
  PayoutAccountsListResponseSchema,
} from '../http/payouts.schema';

const ISO_NOW = '2026-05-16T12:00:00.000Z';

function buildAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'pr_abc',
    stripeAccountId: 'acct_stub_pr_abc',
    country: 'US',
    defaultCurrency: 'USD',
    status: 'pending_onboarding',
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    liveMode: false,
    requirementsCurrentlyDue: [],
    requirementsPastDue: [],
    disabledReason: null,
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    ...overrides,
  };
}

describe('PayoutAccountStatusSchema', () => {
  it.each(['pending_onboarding', 'restricted', 'active', 'disabled'] as const)(
    'accepts %s',
    (value) => {
      expect(PayoutAccountStatusSchema.parse(value)).toBe(value);
    },
  );

  it('rejects an unknown status', () => {
    expect(() => PayoutAccountStatusSchema.parse('ready')).toThrow();
  });
});

describe('PayoutAccountLinkKindSchema', () => {
  it.each(['account_onboarding', 'account_update'] as const)('accepts %s', (value) => {
    expect(PayoutAccountLinkKindSchema.parse(value)).toBe(value);
  });

  it('rejects an unknown kind', () => {
    expect(() => PayoutAccountLinkKindSchema.parse('settings')).toThrow();
  });
});

describe('CreateConnectAccountRequestSchema', () => {
  it('accepts an empty body (defaults applied server-side)', () => {
    const parsed = CreateConnectAccountRequestSchema.parse({});
    expect(parsed.country).toBeUndefined();
    expect(parsed.defaultCurrency).toBeUndefined();
  });

  it('accepts country + currency overrides', () => {
    const parsed = CreateConnectAccountRequestSchema.parse({
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(parsed.country).toBe('US');
    expect(parsed.defaultCurrency).toBe('USD');
  });

  it('rejects a lower-case country code', () => {
    expect(() => CreateConnectAccountRequestSchema.parse({ country: 'us' })).toThrow();
  });

  it('rejects a 3-letter country code', () => {
    expect(() => CreateConnectAccountRequestSchema.parse({ country: 'USA' })).toThrow();
  });

  it('rejects a 2-letter currency code', () => {
    expect(() => CreateConnectAccountRequestSchema.parse({ defaultCurrency: 'US' })).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() => CreateConnectAccountRequestSchema.parse({ country: 'US', extra: 1 })).toThrow();
  });
});

describe('CreateAccountLinkRequestSchema', () => {
  it('accepts a happy onboarding-link request', () => {
    const parsed = CreateAccountLinkRequestSchema.parse({
      refreshUrl: 'https://app.example.com/onboarding/refresh',
      returnUrl: 'https://app.example.com/onboarding/return',
    });
    expect(parsed.kind).toBeUndefined();
    expect(parsed.refreshUrl).toBe('https://app.example.com/onboarding/refresh');
  });

  it('accepts an explicit account_update kind', () => {
    const parsed = CreateAccountLinkRequestSchema.parse({
      kind: 'account_update',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/done',
    });
    expect(parsed.kind).toBe('account_update');
  });

  it('rejects a non-URL redirect', () => {
    expect(() =>
      CreateAccountLinkRequestSchema.parse({
        refreshUrl: 'not-a-url',
        returnUrl: 'https://app.example.com/done',
      }),
    ).toThrow();
  });

  it('rejects an over-cap redirect URL', () => {
    const huge = `https://app.example.com/${'x'.repeat(PAYOUT_ONBOARDING_URL_MAX_LENGTH)}`;
    expect(() =>
      CreateAccountLinkRequestSchema.parse({
        refreshUrl: huge,
        returnUrl: 'https://app.example.com/done',
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      CreateAccountLinkRequestSchema.parse({
        refreshUrl: 'https://app.example.com/r',
        returnUrl: 'https://app.example.com/done',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('IngestStripeAccountEventRequestSchema', () => {
  const baseEvent = {
    stripeEventId: 'evt_test_123',
    eventType: 'account.updated',
    stripeAccountId: 'acct_1NfXyZAbCd012345',
    occurredAt: ISO_NOW,
    payload: {
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    },
  };

  it('accepts a minimal event', () => {
    const parsed = IngestStripeAccountEventRequestSchema.parse(baseEvent);
    expect(parsed.stripeEventId).toBe('evt_test_123');
    expect(parsed.payload.chargesEnabled).toBe(true);
  });

  it('accepts an event with full requirements arrays + disabled reason', () => {
    const parsed = IngestStripeAccountEventRequestSchema.parse({
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        disabledReason: 'requirements.past_due',
        requirementsCurrentlyDue: ['external_account', 'tos_acceptance.date'],
        requirementsPastDue: ['individual.verification.document'],
        defaultCurrency: 'USD',
      },
    });
    expect(parsed.payload.requirementsPastDue).toHaveLength(1);
    expect(parsed.payload.disabledReason).toBe('requirements.past_due');
  });

  it('rejects a payload that exceeds the requirements cap', () => {
    expect(() =>
      IngestStripeAccountEventRequestSchema.parse({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          requirementsCurrentlyDue: Array.from(
            { length: PAYOUT_REQUIREMENTS_MAX_ENTRIES + 1 },
            (_, i) => `req_${i}`,
          ),
        },
      }),
    ).toThrow();
  });

  it('rejects a payload with an over-cap requirement key', () => {
    expect(() =>
      IngestStripeAccountEventRequestSchema.parse({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          requirementsCurrentlyDue: ['x'.repeat(PAYOUT_REQUIREMENT_KEY_MAX_LENGTH + 1)],
        },
      }),
    ).toThrow();
  });

  it('rejects unknown payload fields (strict)', () => {
    expect(() =>
      IngestStripeAccountEventRequestSchema.parse({
        ...baseEvent,
        payload: { ...baseEvent.payload, somethingNew: 1 },
      }),
    ).toThrow();
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(() =>
      IngestStripeAccountEventRequestSchema.parse({
        ...baseEvent,
        livemode: true,
      }),
    ).toThrow();
  });

  it('rejects a malformed datetime', () => {
    expect(() =>
      IngestStripeAccountEventRequestSchema.parse({
        ...baseEvent,
        occurredAt: '2026-05-16',
      }),
    ).toThrow();
  });
});

describe('PayoutAccountResponseSchema', () => {
  it('accepts a happy pending account', () => {
    const parsed = PayoutAccountResponseSchema.parse(buildAccount());
    expect(parsed.status).toBe('pending_onboarding');
    expect(parsed.liveMode).toBe(false);
  });

  it('accepts an active account with cleared requirements', () => {
    const parsed = PayoutAccountResponseSchema.parse(
      buildAccount({
        status: 'active',
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        liveMode: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
      }),
    );
    expect(parsed.status).toBe('active');
    expect(parsed.liveMode).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      PayoutAccountResponseSchema.parse({ ...buildAccount(), legacyField: 1 }),
    ).toThrow();
  });

  it('rejects a malformed createdAt', () => {
    expect(() =>
      PayoutAccountResponseSchema.parse(buildAccount({ createdAt: 'yesterday' })),
    ).toThrow();
  });
});

describe('CreateConnectAccountResponseSchema', () => {
  it('accepts the created outcome', () => {
    const parsed = CreateConnectAccountResponseSchema.parse({
      outcome: 'created',
      account: buildAccount(),
    });
    expect(parsed.outcome).toBe('created');
  });

  it('accepts the existing outcome', () => {
    const parsed = CreateConnectAccountResponseSchema.parse({
      outcome: 'existing',
      account: buildAccount({ status: 'active', chargesEnabled: true }),
    });
    expect(parsed.outcome).toBe('existing');
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      CreateConnectAccountResponseSchema.parse({
        outcome: 'recreated',
        account: buildAccount(),
      }),
    ).toThrow();
  });
});

describe('CreateAccountLinkResponseSchema', () => {
  it('accepts a happy onboarding link response', () => {
    const parsed = CreateAccountLinkResponseSchema.parse({
      kind: 'account_onboarding',
      url: 'https://connect.stripe.com/express/onboarding/abc',
      expiresAt: ISO_NOW,
      liveMode: false,
    });
    expect(parsed.kind).toBe('account_onboarding');
  });

  it('rejects a non-URL link value', () => {
    expect(() =>
      CreateAccountLinkResponseSchema.parse({
        kind: 'account_onboarding',
        url: 'not-a-url',
        expiresAt: ISO_NOW,
        liveMode: false,
      }),
    ).toThrow();
  });
});

describe('IngestStripeAccountEventResponseSchema', () => {
  it('accepts applied outcome with an account', () => {
    const parsed = IngestStripeAccountEventResponseSchema.parse({
      outcome: 'applied',
      account: buildAccount({ status: 'active' }),
    });
    expect(parsed.outcome).toBe('applied');
  });

  it('accepts ignored outcome with null account', () => {
    const parsed = IngestStripeAccountEventResponseSchema.parse({
      outcome: 'ignored',
      account: null,
    });
    expect(parsed.account).toBeNull();
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      IngestStripeAccountEventResponseSchema.parse({
        outcome: 'rejected',
        account: null,
      }),
    ).toThrow();
  });
});

describe('ListPayoutAccountsQuerySchema', () => {
  it('applies the default limit', () => {
    const parsed = ListPayoutAccountsQuerySchema.parse({});
    expect(parsed.limit).toBe(PAYOUT_LIST_LIMIT_DEFAULT);
  });

  it('coerces a numeric-string limit', () => {
    const parsed = ListPayoutAccountsQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('rejects a limit over the cap', () => {
    expect(() =>
      ListPayoutAccountsQuerySchema.parse({
        limit: PAYOUT_LIST_LIMIT_MAX + 1,
      }),
    ).toThrow();
  });

  it('accepts a status filter + cursor', () => {
    const parsed = ListPayoutAccountsQuerySchema.parse({
      status: 'restricted',
      cursor: 'eyJpZCI6ImFiYyJ9',
    });
    expect(parsed.status).toBe('restricted');
    expect(parsed.cursor).toBe('eyJpZCI6ImFiYyJ9');
  });

  it('rejects an unknown filter field (strict)', () => {
    expect(() =>
      ListPayoutAccountsQuerySchema.parse({ status: 'active', tier: 'elite' }),
    ).toThrow();
  });
});

describe('PayoutAccountsListResponseSchema', () => {
  it('accepts an empty list', () => {
    const parsed = PayoutAccountsListResponseSchema.parse({
      rows: [],
      nextCursor: null,
    });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts a paged list with cursor', () => {
    const parsed = PayoutAccountsListResponseSchema.parse({
      rows: [buildAccount(), buildAccount({ providerId: 'pr_def' })],
      nextCursor: 'eyJpZCI6InByX2RlZiJ9',
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.nextCursor).toBe('eyJpZCI6InByX2RlZiJ9');
  });
});
