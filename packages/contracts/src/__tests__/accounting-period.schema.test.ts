import { describe, expect, it } from 'vitest';

import {
  ClosePeriodRequestSchema,
  GENERATE_PERIODS_MAX_COUNT,
  GeneratePeriodsRequestSchema,
  GeneratePeriodsResponseSchema,
  LIST_PERIODS_LIMIT_DEFAULT,
  LIST_PERIODS_LIMIT_MAX,
  ListPeriodsQuerySchema,
  PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH,
  PERIOD_LIFECYCLE_REASON_MAX_LENGTH,
  PERIOD_NAME_MAX_LENGTH,
  PERIOD_NAME_REGEX,
  PeriodLifecycleEventKindSchema,
  PeriodLifecycleEventResponseSchema,
  PeriodLifecycleResponseSchema,
  PeriodNameSchema,
  PeriodResponseSchema,
  PeriodStatusSchema,
  PeriodsListResponseSchema,
  ReopenPeriodRequestSchema,
} from '../http/accounting-period.schema';

describe('PeriodStatusSchema', () => {
  it('accepts open and closed', () => {
    expect(PeriodStatusSchema.parse('open')).toBe('open');
    expect(PeriodStatusSchema.parse('closed')).toBe('closed');
  });

  it('rejects unknown statuses', () => {
    expect(PeriodStatusSchema.safeParse('locked').success).toBe(false);
    expect(PeriodStatusSchema.safeParse('archived').success).toBe(false);
  });
});

describe('PeriodLifecycleEventKindSchema', () => {
  it('accepts close and reopen', () => {
    expect(PeriodLifecycleEventKindSchema.parse('close')).toBe('close');
    expect(PeriodLifecycleEventKindSchema.parse('reopen')).toBe('reopen');
  });

  it('rejects unknown kinds', () => {
    expect(PeriodLifecycleEventKindSchema.safeParse('open').success).toBe(false);
    expect(PeriodLifecycleEventKindSchema.safeParse('close-period').success).toBe(false);
  });
});

describe('PeriodNameSchema', () => {
  it('accepts canonical YYYY-MM names across the 12 months', () => {
    for (const month of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
      expect(PeriodNameSchema.parse(`2026-${month}`)).toBe(`2026-${month}`);
    }
  });

  it('rejects single-digit months', () => {
    expect(PeriodNameSchema.safeParse('2026-1').success).toBe(false);
    expect(PeriodNameSchema.safeParse('2026-5').success).toBe(false);
  });

  it('rejects out-of-range months', () => {
    expect(PeriodNameSchema.safeParse('2026-00').success).toBe(false);
    expect(PeriodNameSchema.safeParse('2026-13').success).toBe(false);
    expect(PeriodNameSchema.safeParse('2026-99').success).toBe(false);
  });

  it('rejects 3-digit and 5-digit years', () => {
    expect(PeriodNameSchema.safeParse('999-05').success).toBe(false);
    expect(PeriodNameSchema.safeParse('20260-05').success).toBe(false);
  });

  it('rejects quarterly-shaped strings', () => {
    expect(PeriodNameSchema.safeParse('2026-Q2').success).toBe(false);
  });

  it('rejects whitespace and empty strings', () => {
    expect(PeriodNameSchema.safeParse(' 2026-05').success).toBe(false);
    expect(PeriodNameSchema.safeParse('2026-05 ').success).toBe(false);
    expect(PeriodNameSchema.safeParse('').success).toBe(false);
  });

  it('exposes the regex + length constants for downstream reuse', () => {
    expect(PERIOD_NAME_REGEX.test('2026-05')).toBe(true);
    expect(PERIOD_NAME_REGEX.test('not-a-period')).toBe(false);
    expect(PERIOD_NAME_MAX_LENGTH).toBe(64);
  });
});

describe('PeriodResponseSchema', () => {
  const validBody = {
    id: 'prd_abc',
    name: '2026-05',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    status: 'open' as const,
    closedAt: null,
    closedByUserId: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  it('accepts a canonical open period', () => {
    expect(PeriodResponseSchema.parse(validBody)).toEqual(validBody);
  });

  it('accepts a closed period with closedAt + closedByUserId set', () => {
    const closed = {
      ...validBody,
      status: 'closed' as const,
      closedAt: '2026-06-05T15:00:00.000Z',
      closedByUserId: 'usr_finance',
    };
    expect(PeriodResponseSchema.parse(closed)).toEqual(closed);
  });

  it('rejects startDate / endDate that are not YYYY-MM-DD', () => {
    expect(PeriodResponseSchema.safeParse({ ...validBody, startDate: '2026/05/01' }).success).toBe(
      false,
    );
    expect(
      PeriodResponseSchema.safeParse({
        ...validBody,
        endDate: '2026-05-31T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(PeriodResponseSchema.safeParse({ ...validBody, extra: 'nope' }).success).toBe(false);
  });
});

describe('ListPeriodsQuerySchema', () => {
  it('defaults limit to undefined (controller layer applies the default)', () => {
    expect(ListPeriodsQuerySchema.parse({}).limit).toBeUndefined();
    expect(LIST_PERIODS_LIMIT_DEFAULT).toBe(50);
    expect(LIST_PERIODS_LIMIT_MAX).toBe(100);
  });

  it('coerces string limit values to numbers', () => {
    const parsed = ListPeriodsQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('rejects limit above the cap', () => {
    expect(ListPeriodsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });

  it('accepts optional status + cursor', () => {
    const parsed = ListPeriodsQuerySchema.parse({
      status: 'closed',
      cursor: 'opaque-cursor',
    });
    expect(parsed.status).toBe('closed');
    expect(parsed.cursor).toBe('opaque-cursor');
  });

  it('rejects unknown query keys', () => {
    expect(ListPeriodsQuerySchema.safeParse({ status: 'open', extra: 'nope' }).success).toBe(false);
  });
});

describe('PeriodsListResponseSchema', () => {
  it('accepts a canonical paginated response', () => {
    const body = {
      periods: [],
      nextCursor: null,
    };
    expect(PeriodsListResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a populated response with a string cursor', () => {
    const period = {
      id: 'prd_a',
      name: '2026-04',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      status: 'closed' as const,
      closedAt: '2026-05-02T14:00:00.000Z',
      closedByUserId: 'usr_finance',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-05-02T14:00:00.000Z',
    };
    const body = { periods: [period], nextCursor: 'c_2026-04-01' };
    expect(PeriodsListResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      PeriodsListResponseSchema.safeParse({
        periods: [],
        nextCursor: null,
        total: 0,
      }).success,
    ).toBe(false);
  });
});

describe('ClosePeriodRequestSchema', () => {
  const validBody = {
    sourceEventId: 'evt_period_close_2026-05',
    occurredAt: '2026-06-05T15:00:00.000Z',
    reasonCode: 'monthly_close',
    description: 'May 2026 monthly close after Stripe reconciliation.',
  };

  it('accepts a canonical close body', () => {
    expect(ClosePeriodRequestSchema.parse(validBody)).toEqual(validBody);
  });

  it('accepts a minimal body without occurredAt or description', () => {
    const { occurredAt, description, ...rest } = validBody;
    void occurredAt;
    void description;
    expect(ClosePeriodRequestSchema.parse(rest)).toEqual(rest);
  });

  it('rejects missing sourceEventId', () => {
    const { sourceEventId, ...rest } = validBody;
    void sourceEventId;
    expect(ClosePeriodRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects empty reasonCode', () => {
    expect(ClosePeriodRequestSchema.safeParse({ ...validBody, reasonCode: '' }).success).toBe(
      false,
    );
  });

  it('rejects reasonCode above the cap', () => {
    expect(
      ClosePeriodRequestSchema.safeParse({
        ...validBody,
        reasonCode: 'x'.repeat(PERIOD_LIFECYCLE_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects description above the cap', () => {
    expect(
      ClosePeriodRequestSchema.safeParse({
        ...validBody,
        description: 'x'.repeat(PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects malformed occurredAt', () => {
    expect(
      ClosePeriodRequestSchema.safeParse({ ...validBody, occurredAt: 'tomorrow' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(ClosePeriodRequestSchema.safeParse({ ...validBody, extra: 'nope' }).success).toBe(false);
  });
});

describe('ReopenPeriodRequestSchema', () => {
  it('accepts a canonical reopen body', () => {
    const body = {
      sourceEventId: 'evt_period_reopen_2026-04',
      occurredAt: '2026-06-10T09:30:00.000Z',
      reasonCode: 'late_invoice_adjustment',
      description: 'Reopening April 2026 to post a late Stripe refund.',
    };
    expect(ReopenPeriodRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects empty sourceEventId', () => {
    expect(
      ReopenPeriodRequestSchema.safeParse({
        sourceEventId: '',
        reasonCode: 'late_adjust',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      ReopenPeriodRequestSchema.safeParse({
        sourceEventId: 'evt_x',
        reasonCode: 'r',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('PeriodLifecycleEventResponseSchema', () => {
  const valid = {
    id: 'evt_abc',
    periodId: 'prd_abc',
    periodName: '2026-05',
    kind: 'close' as const,
    actorUserId: 'usr_finance',
    sourceEventId: 'evt_period_close_2026-05',
    reasonCode: 'monthly_close',
    description: null,
    occurredAt: '2026-06-05T15:00:00.000Z',
    createdAt: '2026-06-05T15:00:01.000Z',
  };

  it('accepts a canonical close event with null description', () => {
    expect(PeriodLifecycleEventResponseSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a reopen event with non-null description', () => {
    const reopen = {
      ...valid,
      kind: 'reopen' as const,
      description: 'late stripe refund',
    };
    expect(PeriodLifecycleEventResponseSchema.parse(reopen)).toEqual(reopen);
  });

  it('rejects unknown fields', () => {
    expect(PeriodLifecycleEventResponseSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('PeriodLifecycleResponseSchema', () => {
  const period = {
    id: 'prd_abc',
    name: '2026-05',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    status: 'closed' as const,
    closedAt: '2026-06-05T15:00:00.000Z',
    closedByUserId: 'usr_finance',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-06-05T15:00:00.000Z',
  };
  const event = {
    id: 'evt_abc',
    periodId: 'prd_abc',
    periodName: '2026-05',
    kind: 'close' as const,
    actorUserId: 'usr_finance',
    sourceEventId: 'evt_period_close_2026-05',
    reasonCode: 'monthly_close',
    description: null,
    occurredAt: '2026-06-05T15:00:00.000Z',
    createdAt: '2026-06-05T15:00:01.000Z',
  };

  it('accepts a canonical close response', () => {
    const body = { period, event, result: 'closed' as const };
    expect(PeriodLifecycleResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a reopened response', () => {
    const reopenPeriod = { ...period, status: 'open' as const };
    const reopenEvent = { ...event, kind: 'reopen' as const };
    const body = {
      period: reopenPeriod,
      event: reopenEvent,
      result: 'reopened' as const,
    };
    expect(PeriodLifecycleResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an idempotent_replay discriminator', () => {
    const body = { period, event, result: 'idempotent_replay' as const };
    expect(PeriodLifecycleResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown result discriminator', () => {
    expect(
      PeriodLifecycleResponseSchema.safeParse({
        period,
        event,
        result: 'partially_closed',
      }).success,
    ).toBe(false);
  });
});

describe('GeneratePeriodsRequestSchema', () => {
  it('accepts a canonical inclusive range', () => {
    const body = { startYearMonth: '2026-01', endYearMonth: '2026-12' };
    expect(GeneratePeriodsRequestSchema.parse(body)).toEqual(body);
  });

  it('accepts a single-month range (start == end)', () => {
    const body = { startYearMonth: '2026-05', endYearMonth: '2026-05' };
    expect(GeneratePeriodsRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects an inverted range (start > end)', () => {
    expect(
      GeneratePeriodsRequestSchema.safeParse({
        startYearMonth: '2026-12',
        endYearMonth: '2026-01',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed year-months', () => {
    expect(
      GeneratePeriodsRequestSchema.safeParse({
        startYearMonth: '2026-1',
        endYearMonth: '2026-12',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      GeneratePeriodsRequestSchema.safeParse({
        startYearMonth: '2026-01',
        endYearMonth: '2026-12',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });

  it('exposes the max-count constant', () => {
    expect(GENERATE_PERIODS_MAX_COUNT).toBe(60);
  });
});

describe('GeneratePeriodsResponseSchema', () => {
  const period = {
    id: 'prd_a',
    name: '2026-05',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    status: 'open' as const,
    closedAt: null,
    closedByUserId: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  it('accepts a canonical generate response', () => {
    const body = {
      startYearMonth: '2026-05',
      endYearMonth: '2026-05',
      requestedCount: 1,
      createdCount: 1,
      existedCount: 0,
      created: [period],
      existed: [],
    };
    expect(GeneratePeriodsResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a body where everything pre-existed', () => {
    const body = {
      startYearMonth: '2026-05',
      endYearMonth: '2026-06',
      requestedCount: 2,
      createdCount: 0,
      existedCount: 2,
      created: [],
      existed: [
        period,
        { ...period, name: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30' },
      ],
    };
    expect(GeneratePeriodsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects negative counts', () => {
    expect(
      GeneratePeriodsResponseSchema.safeParse({
        startYearMonth: '2026-05',
        endYearMonth: '2026-05',
        requestedCount: -1,
        createdCount: 0,
        existedCount: 0,
        created: [],
        existed: [],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      GeneratePeriodsResponseSchema.safeParse({
        startYearMonth: '2026-05',
        endYearMonth: '2026-05',
        requestedCount: 1,
        createdCount: 1,
        existedCount: 0,
        created: [period],
        existed: [],
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});
