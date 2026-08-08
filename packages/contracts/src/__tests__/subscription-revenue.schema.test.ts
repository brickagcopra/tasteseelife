import { describe, expect, it } from 'vitest';

import {
  CancelDeferredRevenueRequestSchema,
  CancelDeferredRevenueResponseSchema,
  DeferredRevenueStatusSchema,
  PLAN_CODE_REGEX,
  PlanCodeSchema,
  RECOGNITION_AMOUNT_MAX_MINOR,
  RecognizeActivationRequestSchema,
  RecognizeActivationResponseSchema,
  RecognizeDailyReportSchema,
  RecognizeDailyRequestSchema,
} from '../http/subscription-revenue.schema';

describe('DeferredRevenueStatusSchema', () => {
  it('accepts every lifecycle variant', () => {
    for (const s of ['active', 'fully_recognized', 'canceled', 'paused'] as const) {
      expect(DeferredRevenueStatusSchema.parse(s)).toBe(s);
    }
  });

  it('accepts paused as a value distinct from canceled (TS-042-followup-3b2)', () => {
    // A paused balance's amortisation WILL complete, just later — resume
    // extends the service period by the suspended duration. `canceled`
    // is halted-until-TS-084 and reusing it would strand the balance.
    expect(DeferredRevenueStatusSchema.parse('paused')).toBe('paused');
    expect(DeferredRevenueStatusSchema.options).toEqual([
      'active',
      'fully_recognized',
      'canceled',
      'paused',
    ]);
  });

  it('rejects unknown statuses', () => {
    expect(DeferredRevenueStatusSchema.safeParse('refunded').success).toBe(false);
    expect(DeferredRevenueStatusSchema.safeParse('suspended').success).toBe(false);
  });
});

describe('PlanCodeSchema', () => {
  it('accepts dot-notation plan codes', () => {
    for (const code of [
      'family.tier1',
      'family.tier2',
      'family.tier3',
      'provider.basic',
      'provider.certified',
      'provider.elite',
      'academy.membership',
    ]) {
      expect(PlanCodeSchema.parse(code)).toBe(code);
    }
  });

  it('rejects upper-case or whitespace', () => {
    expect(PlanCodeSchema.safeParse('Family.Tier1').success).toBe(false);
    expect(PlanCodeSchema.safeParse('family tier1').success).toBe(false);
    expect(PlanCodeSchema.safeParse('family-tier1').success).toBe(false);
  });

  it('requires at least one dot', () => {
    expect(PlanCodeSchema.safeParse('family').success).toBe(false);
    expect(PlanCodeSchema.safeParse('tier1').success).toBe(false);
  });

  it('rejects trailing or leading dots', () => {
    expect(PlanCodeSchema.safeParse('.family.tier1').success).toBe(false);
    expect(PlanCodeSchema.safeParse('family.tier1.').success).toBe(false);
    expect(PlanCodeSchema.safeParse('family..tier1').success).toBe(false);
  });

  it('rejects digit-leading segments', () => {
    // The regex requires each segment to start with a lowercase letter.
    expect(PlanCodeSchema.safeParse('1family.tier1').success).toBe(false);
    expect(PlanCodeSchema.safeParse('family.1tier').success).toBe(false);
  });

  it('exposes the regex constant for downstream reuse', () => {
    expect(PLAN_CODE_REGEX.test('family.tier1')).toBe(true);
    expect(PLAN_CODE_REGEX.test('Family.tier1')).toBe(false);
  });
});

describe('RecognizeActivationRequestSchema', () => {
  const validBody = {
    subscriptionId: 'sub_abc',
    customerId: 'cus_abc',
    customerGroup: 'family' as const,
    planCode: 'family.tier2',
    amountMinor: 29900,
    currency: 'USD' as const,
    servicePeriodStart: '2026-05-01T00:00:00.000Z',
    servicePeriodEnd: '2026-05-31T23:59:59.999Z',
    sourceEventId: 'evt_subscription.activated_abc',
    occurredAt: '2026-05-01T12:00:00.000Z',
  };

  it('accepts a canonical activation body', () => {
    const parsed = RecognizeActivationRequestSchema.parse(validBody);
    expect(parsed.amountMinor).toBe(29900);
    expect(parsed.customerGroup).toBe('family');
    expect(parsed.planCode).toBe('family.tier2');
    expect(parsed.currency).toBe('USD');
  });

  it('defaults currency to USD when omitted', () => {
    const { currency, ...rest } = validBody;
    void currency;
    const parsed = RecognizeActivationRequestSchema.parse(rest);
    expect(parsed.currency).toBe('USD');
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        extra: 'unexpected',
      }).success,
    ).toBe(false);
  });

  it('rejects amountMinor < 1', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        amountMinor: 0,
      }).success,
    ).toBe(false);
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        amountMinor: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects fractional amountMinor', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        amountMinor: 29900.5,
      }).success,
    ).toBe(false);
  });

  it('rejects amountMinor exceeding the cap', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        amountMinor: RECOGNITION_AMOUNT_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts amountMinor exactly at the cap', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        amountMinor: RECOGNITION_AMOUNT_MAX_MINOR,
      }).success,
    ).toBe(true);
  });

  it('rejects servicePeriodStart >= servicePeriodEnd', () => {
    const result = RecognizeActivationRequestSchema.safeParse({
      ...validBody,
      servicePeriodStart: '2026-06-01T00:00:00.000Z',
      servicePeriodEnd: '2026-05-31T23:59:59.999Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects servicePeriodStart === servicePeriodEnd', () => {
    const ts = '2026-05-01T00:00:00.000Z';
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        servicePeriodStart: ts,
        servicePeriodEnd: ts,
      }).success,
    ).toBe(false);
  });

  it('rejects malformed datetime strings', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        servicePeriodStart: 'May 1st 2026',
      }).success,
    ).toBe(false);
  });

  it('accepts an optional description', () => {
    const parsed = RecognizeActivationRequestSchema.parse({
      ...validBody,
      description: 'Activation of family.tier2 sub for cus_abc',
    });
    expect(parsed.description).toBe('Activation of family.tier2 sub for cus_abc');
  });

  it('accepts a context object', () => {
    const parsed = RecognizeActivationRequestSchema.parse({
      ...validBody,
      context: { stripeInvoiceId: 'in_abc', billingInterval: 'monthly' },
    });
    expect(parsed.context).toEqual({
      stripeInvoiceId: 'in_abc',
      billingInterval: 'monthly',
    });
  });

  it('rejects unknown currency', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        currency: 'EUR',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown customerGroup', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        customerGroup: 'partner',
      }).success,
    ).toBe(false);
  });

  it('rejects empty sourceEventId', () => {
    expect(
      RecognizeActivationRequestSchema.safeParse({
        ...validBody,
        sourceEventId: '',
      }).success,
    ).toBe(false);
  });
});

describe('RecognizeActivationResponseSchema', () => {
  const validResponse = {
    balanceId: 'drb_abc',
    subscriptionId: 'sub_abc',
    activationJournalId: 'jrn_abc',
    originalAmountMinor: 29900,
    recognizedAmountMinor: 0,
    currency: 'USD' as const,
    servicePeriodStart: '2026-05-01T00:00:00.000Z',
    servicePeriodEnd: '2026-05-31T23:59:59.999Z',
    status: 'active' as const,
    result: 'created' as const,
  };

  it('accepts a fresh-create response', () => {
    const parsed = RecognizeActivationResponseSchema.parse(validResponse);
    expect(parsed.result).toBe('created');
    expect(parsed.status).toBe('active');
  });

  it('accepts an idempotent-replay response', () => {
    const parsed = RecognizeActivationResponseSchema.parse({
      ...validResponse,
      result: 'idempotent_replay',
      recognizedAmountMinor: 9650,
    });
    expect(parsed.result).toBe('idempotent_replay');
    expect(parsed.recognizedAmountMinor).toBe(9650);
  });

  it('rejects unknown result values', () => {
    expect(
      RecognizeActivationResponseSchema.safeParse({
        ...validResponse,
        result: 'updated',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      RecognizeActivationResponseSchema.safeParse({
        ...validResponse,
        extra: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('CancelDeferredRevenueRequestSchema', () => {
  const validBody = {
    subscriptionId: 'sub_abc',
    servicePeriodStart: '2026-05-01T00:00:00.000Z',
    sourceEventId: 'evt_subscription.canceled_abc',
    occurredAt: '2026-05-15T12:00:00.000Z',
  };

  it('accepts a canonical cancel body', () => {
    const parsed = CancelDeferredRevenueRequestSchema.parse(validBody);
    expect(parsed.subscriptionId).toBe('sub_abc');
  });

  it('accepts an optional reason', () => {
    const parsed = CancelDeferredRevenueRequestSchema.parse({
      ...validBody,
      reason: 'Customer requested cancellation',
    });
    expect(parsed.reason).toBe('Customer requested cancellation');
  });

  it('rejects unknown top-level fields', () => {
    expect(
      CancelDeferredRevenueRequestSchema.safeParse({
        ...validBody,
        force: true,
      }).success,
    ).toBe(false);
  });

  it('rejects malformed servicePeriodStart', () => {
    expect(
      CancelDeferredRevenueRequestSchema.safeParse({
        ...validBody,
        servicePeriodStart: 'May 2026',
      }).success,
    ).toBe(false);
  });
});

describe('CancelDeferredRevenueResponseSchema', () => {
  const validResponse = {
    balanceId: 'drb_abc',
    subscriptionId: 'sub_abc',
    previousStatus: 'active' as const,
    status: 'canceled' as const,
    remainingDeferredMinor: 20250,
    result: 'canceled' as const,
  };

  it('accepts a fresh cancel response', () => {
    const parsed = CancelDeferredRevenueResponseSchema.parse(validResponse);
    expect(parsed.previousStatus).toBe('active');
    expect(parsed.status).toBe('canceled');
  });

  it('accepts an idempotent-replay response', () => {
    const parsed = CancelDeferredRevenueResponseSchema.parse({
      ...validResponse,
      previousStatus: 'canceled' as const,
      result: 'idempotent_replay' as const,
    });
    expect(parsed.result).toBe('idempotent_replay');
  });

  it('rejects unknown top-level fields', () => {
    expect(
      CancelDeferredRevenueResponseSchema.safeParse({
        ...validResponse,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('RecognizeDailyRequestSchema', () => {
  it('accepts an empty body', () => {
    const parsed = RecognizeDailyRequestSchema.parse({});
    expect(parsed.asOf).toBeUndefined();
  });

  it('accepts an asOf datetime', () => {
    const parsed = RecognizeDailyRequestSchema.parse({
      asOf: '2026-05-15T03:00:00.000Z',
    });
    expect(parsed.asOf).toBe('2026-05-15T03:00:00.000Z');
  });

  it('rejects unknown fields', () => {
    expect(
      RecognizeDailyRequestSchema.safeParse({ asOf: '2026-05-15T03:00:00.000Z', dryRun: true })
        .success,
    ).toBe(false);
  });

  it('rejects malformed asOf', () => {
    expect(RecognizeDailyRequestSchema.safeParse({ asOf: 'today' }).success).toBe(false);
  });
});

describe('RecognizeDailyReportSchema', () => {
  it('accepts a canonical sweep report', () => {
    const parsed = RecognizeDailyReportSchema.parse({
      asOf: '2026-05-15T03:00:00.000Z',
      scannedCount: 100,
      recognizedCount: 95,
      skippedCount: 4,
      completedCount: 1,
      failedCount: 0,
      totalRecognizedMinor: 92_350_00,
    });
    expect(parsed.recognizedCount).toBe(95);
    expect(parsed.totalRecognizedMinor).toBe(92_350_00);
  });

  it('rejects negative counts', () => {
    expect(
      RecognizeDailyReportSchema.safeParse({
        asOf: '2026-05-15T03:00:00.000Z',
        scannedCount: -1,
        recognizedCount: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 0,
        totalRecognizedMinor: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects fractional counts', () => {
    expect(
      RecognizeDailyReportSchema.safeParse({
        asOf: '2026-05-15T03:00:00.000Z',
        scannedCount: 1.5,
        recognizedCount: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 0,
        totalRecognizedMinor: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      RecognizeDailyReportSchema.safeParse({
        asOf: '2026-05-15T03:00:00.000Z',
        scannedCount: 0,
        recognizedCount: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 0,
        totalRecognizedMinor: 0,
        elapsedMs: 123,
      }).success,
    ).toBe(false);
  });
});
