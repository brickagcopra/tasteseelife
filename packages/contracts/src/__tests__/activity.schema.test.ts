import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_LIST_LIMIT_DEFAULT,
  ACTIVITY_LIST_LIMIT_MAX,
  ACTIVITY_METADATA_PAYLOAD_MAX_BYTES,
  ACTIVITY_USER_AGENT_MAX_LENGTH,
  ActivityEventKindSchema,
  ActivityEventResponseSchema,
  ActivityEventsListResponseSchema,
  ListMyActivityQuerySchema,
  ListUserActivityQuerySchema,
  RecordActivityEventRequestSchema,
  RecordActivityEventResponseSchema,
} from '../http';

describe('ActivityEventKindSchema', () => {
  it('accepts every documented kind', () => {
    (
      [
        'login_success',
        'login_failure',
        'logout',
        'password_changed',
        'mfa_enrolled',
        'mfa_removed',
        'profile_changed',
        'payment_method_added',
        'payment_method_removed',
        'subscription_changed',
        'booking_created',
        'booking_canceled',
        'role_granted',
        'role_revoked',
        'suspicious_activity_flag',
      ] as const
    ).forEach((value) => {
      expect(ActivityEventKindSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown kinds', () => {
    expect(ActivityEventKindSchema.safeParse('coffee_ordered').success).toBe(false);
  });
});

describe('RecordActivityEventRequestSchema', () => {
  const minimalBody = {
    eventId: 'evt_001',
    userId: 'user_001',
    kind: 'login_success' as const,
    occurredAt: '2026-05-14T12:00:00.000Z',
  };

  const fullBody = {
    ...minimalBody,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    deviceFingerprint: 'fpr_abc123',
    requestId: 'req_001',
    traceId: 'trace_001',
    metadata: { from: 'tier_1', to: 'tier_2' },
  };

  it('accepts a minimal body (only required fields)', () => {
    expect(RecordActivityEventRequestSchema.safeParse(minimalBody).success).toBe(true);
  });

  it('accepts a fully-populated body', () => {
    expect(RecordActivityEventRequestSchema.safeParse(fullBody).success).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(RecordActivityEventRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const tampered = { ...fullBody, extraField: 'oops' };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects when eventId is missing', () => {
    const { eventId: _omit, ...rest } = minimalBody;
    expect(RecordActivityEventRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects when userId is missing', () => {
    const { userId: _omit, ...rest } = minimalBody;
    expect(RecordActivityEventRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects when kind is missing', () => {
    const { kind: _omit, ...rest } = minimalBody;
    expect(RecordActivityEventRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty userId', () => {
    expect(RecordActivityEventRequestSchema.safeParse({ ...minimalBody, userId: '' }).success).toBe(
      false,
    );
  });

  it('rejects an occurredAt that is not ISO-8601', () => {
    const tampered = { ...minimalBody, occurredAt: 'not-a-date' };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const tampered = { ...minimalBody, kind: 'pickle_juice' };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a userAgent longer than the cap', () => {
    const tampered = {
      ...minimalBody,
      userAgent: 'x'.repeat(ACTIVITY_USER_AGENT_MAX_LENGTH + 1),
    };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('rejects a metadata payload above the size cap', () => {
    const bloat = 'x'.repeat(ACTIVITY_METADATA_PAYLOAD_MAX_BYTES + 100);
    const tampered = { ...minimalBody, metadata: { bloat } };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('accepts a metadata payload just under the size cap', () => {
    const room = ACTIVITY_METADATA_PAYLOAD_MAX_BYTES - 100;
    const tampered = { ...minimalBody, metadata: { x: 'y'.repeat(room) } };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(true);
  });

  it('rejects a non-serialisable metadata payload', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const tampered = { ...minimalBody, metadata: circular };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(false);
  });

  it('accepts an explicit null on every optional field', () => {
    const tampered = {
      ...minimalBody,
      ip: null,
      userAgent: null,
      deviceFingerprint: null,
      requestId: null,
      traceId: null,
      metadata: null,
    };
    expect(RecordActivityEventRequestSchema.safeParse(tampered).success).toBe(true);
  });
});

describe('ActivityEventResponseSchema', () => {
  it('round-trips a fully-populated response', () => {
    const event = {
      id: 'row_000001',
      eventId: 'evt_001',
      userId: 'user_001',
      kind: 'login_success' as const,
      occurredAt: '2026-05-14T12:00:00.000Z',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      deviceFingerprint: 'fpr_abc',
      requestId: 'req_001',
      traceId: 'trace_001',
      metadata: { from: 'tier_1' },
      createdAt: '2026-05-14T12:00:01.000Z',
    };
    expect(ActivityEventResponseSchema.safeParse(event).success).toBe(true);
  });

  it('rejects unknown fields (strict mode)', () => {
    const event = {
      id: 'row_000001',
      eventId: 'evt_001',
      userId: 'user_001',
      kind: 'login_success' as const,
      occurredAt: '2026-05-14T12:00:00.000Z',
      ip: null,
      userAgent: null,
      deviceFingerprint: null,
      requestId: null,
      traceId: null,
      metadata: null,
      createdAt: '2026-05-14T12:00:01.000Z',
      bonusField: 'oops',
    };
    expect(ActivityEventResponseSchema.safeParse(event).success).toBe(false);
  });

  it('rejects when kind is missing', () => {
    const event = {
      id: 'row_000001',
      eventId: 'evt_001',
      userId: 'user_001',
      occurredAt: '2026-05-14T12:00:00.000Z',
      ip: null,
      userAgent: null,
      deviceFingerprint: null,
      requestId: null,
      traceId: null,
      metadata: null,
      createdAt: '2026-05-14T12:00:01.000Z',
    };
    expect(ActivityEventResponseSchema.safeParse(event).success).toBe(false);
  });
});

describe('RecordActivityEventResponseSchema', () => {
  const sampleEvent = {
    id: 'row_000001',
    eventId: 'evt_001',
    userId: 'user_001',
    kind: 'login_success' as const,
    occurredAt: '2026-05-14T12:00:00.000Z',
    ip: null,
    userAgent: null,
    deviceFingerprint: null,
    requestId: null,
    traceId: null,
    metadata: null,
    createdAt: '2026-05-14T12:00:01.000Z',
  };

  it('accepts a recorded-outcome response', () => {
    const response = { outcome: 'recorded' as const, event: sampleEvent };
    expect(RecordActivityEventResponseSchema.safeParse(response).success).toBe(true);
  });

  it('accepts a replayed-outcome response', () => {
    const response = { outcome: 'replayed' as const, event: sampleEvent };
    expect(RecordActivityEventResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects an unknown outcome value', () => {
    const response = { outcome: 'pending', event: sampleEvent };
    expect(RecordActivityEventResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('ListMyActivityQuerySchema', () => {
  it('applies the default limit when omitted', () => {
    const result = ListMyActivityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(ACTIVITY_LIST_LIMIT_DEFAULT);
    }
  });

  it('coerces a string limit', () => {
    const result = ListMyActivityQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it('rejects a limit above the cap', () => {
    expect(
      ListMyActivityQuerySchema.safeParse({ limit: ACTIVITY_LIST_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });

  it('accepts an optional kind filter', () => {
    const result = ListMyActivityQuerySchema.safeParse({ kind: 'login_success' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe('login_success');
  });

  it('rejects an unknown kind filter', () => {
    expect(ListMyActivityQuerySchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });

  it('rejects extra fields (strict mode)', () => {
    expect(ListMyActivityQuerySchema.safeParse({ limit: 10, userId: 'sneaky' }).success).toBe(
      false,
    );
  });
});

describe('ListUserActivityQuerySchema', () => {
  it('applies the default limit when omitted', () => {
    const result = ListUserActivityQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(ACTIVITY_LIST_LIMIT_DEFAULT);
    }
  });

  it('coerces a string limit', () => {
    const result = ListUserActivityQuerySchema.safeParse({ limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(10);
  });

  it('accepts a kind filter and a cursor together', () => {
    const result = ListUserActivityQuerySchema.safeParse({
      kind: 'login_failure',
      cursor: 'cursor-token',
      limit: 25,
    });
    expect(result.success).toBe(true);
  });
});

describe('ActivityEventsListResponseSchema', () => {
  it('round-trips an empty list with no cursor', () => {
    const response = { events: [], nextCursor: null };
    expect(ActivityEventsListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('round-trips a list with a cursor', () => {
    const response = {
      events: [],
      nextCursor: 'eyJvY2N1cnJlZEF0IjoiMjAyNi0wNS0xNFQxMjowMDowMC4wMDBaIiwiaWQiOiJyb3dfMDAwMDAxIn0',
    };
    expect(ActivityEventsListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects extra fields (strict mode)', () => {
    const response = { events: [], nextCursor: null, total: 42 };
    expect(ActivityEventsListResponseSchema.safeParse(response).success).toBe(false);
  });
});
