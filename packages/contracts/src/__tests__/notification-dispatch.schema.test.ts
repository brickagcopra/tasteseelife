import { describe, expect, it } from 'vitest';

import {
  DispatchNotificationRequestSchema,
  DispatchResponseSchema,
  DispatchesListResponseSchema,
  ListDispatchesQuerySchema,
  NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MAX_LENGTH,
  NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MIN_LENGTH,
  NOTIFICATION_DISPATCH_LIST_LIMIT_DEFAULT,
  NOTIFICATION_DISPATCH_LIST_LIMIT_MAX,
  NotificationCategorySchema,
  NotificationDispatchStatusSchema,
  NotificationSuppressionReasonSchema,
  QuietHoursWindowSchema,
  UpsertPreferencesRequestSchema,
  UserPreferencesResponseSchema,
} from '../http';

describe('NotificationCategorySchema', () => {
  it('accepts every documented category', () => {
    (['transactional', 'marketing', 'system'] as const).forEach((value) => {
      expect(NotificationCategorySchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown categories', () => {
    expect(NotificationCategorySchema.safeParse('promo').success).toBe(false);
  });
});

describe('NotificationDispatchStatusSchema', () => {
  it('accepts the full status set', () => {
    const statuses = [
      'queued',
      'sent',
      'failed',
      'suppressed_by_preference',
      'suppressed_by_quiet_hours',
      'suppressed_by_unsubscribed',
    ] as const;
    statuses.forEach((status) => {
      expect(NotificationDispatchStatusSchema.safeParse(status).success).toBe(true);
    });
  });

  it('rejects unknown statuses', () => {
    expect(NotificationDispatchStatusSchema.safeParse('held').success).toBe(false);
  });
});

describe('NotificationSuppressionReasonSchema', () => {
  it('accepts every suppression reason', () => {
    (
      [
        'preference_opted_out',
        'quiet_hours',
        'globally_unsubscribed',
        'recipient_address_missing',
      ] as const
    ).forEach((value) => {
      expect(NotificationSuppressionReasonSchema.safeParse(value).success).toBe(true);
    });
  });
});

describe('QuietHoursWindowSchema', () => {
  const validWindow = { startMinuteOfDay: 1260, endMinuteOfDay: 480, timeZone: 'America/New_York' };

  it('accepts a wrap-around window', () => {
    expect(QuietHoursWindowSchema.safeParse(validWindow).success).toBe(true);
  });

  it('accepts a same-day window', () => {
    expect(
      QuietHoursWindowSchema.safeParse({
        ...validWindow,
        startMinuteOfDay: 60,
        endMinuteOfDay: 480,
      }).success,
    ).toBe(true);
  });

  it('rejects a zero-width window', () => {
    expect(
      QuietHoursWindowSchema.safeParse({
        ...validWindow,
        startMinuteOfDay: 480,
        endMinuteOfDay: 480,
      }).success,
    ).toBe(false);
  });

  it('rejects minute-of-day out of range', () => {
    expect(QuietHoursWindowSchema.safeParse({ ...validWindow, startMinuteOfDay: -1 }).success).toBe(
      false,
    );
    expect(QuietHoursWindowSchema.safeParse({ ...validWindow, endMinuteOfDay: 1440 }).success).toBe(
      false,
    );
  });

  it('rejects non-integer minutes', () => {
    expect(
      QuietHoursWindowSchema.safeParse({ ...validWindow, startMinuteOfDay: 60.5 }).success,
    ).toBe(false);
  });

  it('rejects empty time zone', () => {
    expect(QuietHoursWindowSchema.safeParse({ ...validWindow, timeZone: '' }).success).toBe(false);
  });

  it('rejects unknown fields under strict mode', () => {
    expect(QuietHoursWindowSchema.safeParse({ ...validWindow, weekdaysOnly: true }).success).toBe(
      false,
    );
  });
});

describe('UpsertPreferencesRequestSchema', () => {
  it('accepts a minimal body', () => {
    const result = UpsertPreferencesRequestSchema.safeParse({ entries: [] });
    expect(result.success).toBe(true);
  });

  it('accepts entries + quiet hours', () => {
    const result = UpsertPreferencesRequestSchema.safeParse({
      entries: [
        { channel: 'email', category: 'transactional', optIn: true },
        { channel: 'sms', category: 'marketing', optIn: false },
      ],
      quietHours: {
        startMinuteOfDay: 1260,
        endMinuteOfDay: 480,
        timeZone: 'America/New_York',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit null quietHours (clear the window)', () => {
    expect(
      UpsertPreferencesRequestSchema.safeParse({ entries: [], quietHours: null }).success,
    ).toBe(true);
  });

  it('caps the entries array length', () => {
    const tooMany = Array.from({ length: 65 }, () => ({
      channel: 'email' as const,
      category: 'transactional' as const,
      optIn: true,
    }));
    expect(UpsertPreferencesRequestSchema.safeParse({ entries: tooMany }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      UpsertPreferencesRequestSchema.safeParse({ entries: [], globalUnsubscribe: true }).success,
    ).toBe(false);
  });

  it('rejects malformed entries (unknown channel)', () => {
    expect(
      UpsertPreferencesRequestSchema.safeParse({
        entries: [{ channel: 'fax', category: 'transactional', optIn: true }],
      }).success,
    ).toBe(false);
  });
});

describe('UserPreferencesResponseSchema', () => {
  const valid = {
    userId: 'user_abc',
    entries: [
      { channel: 'email', category: 'transactional', optIn: true, explicit: false },
      { channel: 'sms', category: 'marketing', optIn: false, explicit: true },
    ],
    quietHours: null,
    seniorMode: false,
    updatedAt: null,
  };

  it('accepts a well-formed response', () => {
    expect(UserPreferencesResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a populated quiet-hours window + datetime', () => {
    const result = UserPreferencesResponseSchema.safeParse({
      ...valid,
      quietHours: {
        startMinuteOfDay: 1260,
        endMinuteOfDay: 480,
        timeZone: 'America/New_York',
      },
      seniorMode: true,
      updatedAt: '2026-05-16T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed ISO datetime', () => {
    expect(
      UserPreferencesResponseSchema.safeParse({ ...valid, updatedAt: 'not-a-date' }).success,
    ).toBe(false);
  });
});

describe('DispatchNotificationRequestSchema', () => {
  const minimal = {
    recipientUserId: 'user_abc',
    channel: 'email' as const,
    category: 'transactional' as const,
    templateCode: 'welcome_family_tier_2',
    locale: 'en-US' as const,
    recipientAddress: 'family@example.com',
    idempotencyKey: 'idempotency-key-0123456789',
  };

  it('accepts a minimal body with bypassQuietHours defaulting to false', () => {
    const result = DispatchNotificationRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bypassQuietHours).toBe(false);
  });

  it('accepts variables', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        variables: { name: 'Alice', tier: 2, isPaid: true },
      }).success,
    ).toBe(true);
  });

  it('accepts bypassQuietHours: true', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({ ...minimal, bypassQuietHours: true }).success,
    ).toBe(true);
  });

  it('rejects an idempotency key shorter than the floor', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        idempotencyKey: 'short',
      }).success,
    ).toBe(false);
  });

  it('rejects an idempotency key over the cap', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        idempotencyKey: 'k'.repeat(NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts the boundary idempotency key length', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        idempotencyKey: 'k'.repeat(NOTIFICATION_DISPATCH_IDEMPOTENCY_KEY_MIN_LENGTH),
      }).success,
    ).toBe(true);
  });

  it('rejects a non-finite number variable', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        variables: { score: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({
        ...minimal,
        priority: 'urgent',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown channel', () => {
    expect(
      DispatchNotificationRequestSchema.safeParse({ ...minimal, channel: 'fax' }).success,
    ).toBe(false);
  });
});

describe('DispatchResponseSchema', () => {
  const sent = {
    id: 'disp_abc',
    recipientUserId: 'user_abc',
    channel: 'email' as const,
    category: 'transactional' as const,
    templateCode: 'welcome_family_tier_2',
    locale: 'en-US' as const,
    templateVersionId: 'ver_abc',
    recipientAddress: 'family@example.com',
    status: 'sent' as const,
    suppressionReason: null,
    providerMessageId: 'postmark_msg_123',
    errorMessage: null,
    idempotencyKey: 'idempotency-key-0123456789',
    sourceEventId: null,
    occurredAt: '2026-05-16T12:00:00.000Z',
    sentAt: '2026-05-16T12:00:00.500Z',
    replayed: false,
  };

  it('accepts a sent dispatch row', () => {
    expect(DispatchResponseSchema.safeParse(sent).success).toBe(true);
  });

  it('accepts a suppressed dispatch row', () => {
    expect(
      DispatchResponseSchema.safeParse({
        ...sent,
        status: 'suppressed_by_quiet_hours',
        suppressionReason: 'quiet_hours',
        providerMessageId: null,
        sentAt: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a failed dispatch row', () => {
    expect(
      DispatchResponseSchema.safeParse({
        ...sent,
        status: 'failed',
        providerMessageId: null,
        errorMessage: 'Postmark 422: invalid recipient',
        sentAt: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a replayed dispatch row', () => {
    expect(DispatchResponseSchema.safeParse({ ...sent, replayed: true }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(DispatchResponseSchema.safeParse({ ...sent, undeliverable: true }).success).toBe(false);
  });
});

describe('ListDispatchesQuerySchema', () => {
  it('applies the default limit', () => {
    const result = ListDispatchesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(NOTIFICATION_DISPATCH_LIST_LIMIT_DEFAULT);
  });

  it('coerces a string limit', () => {
    const result = ListDispatchesQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it('rejects an over-cap limit', () => {
    expect(
      ListDispatchesQuerySchema.safeParse({ limit: NOTIFICATION_DISPATCH_LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('accepts every filter together', () => {
    const result = ListDispatchesQuerySchema.safeParse({
      recipientUserId: 'user_abc',
      channel: 'email',
      category: 'transactional',
      status: 'sent',
      cursor: 'opaque-cursor',
      limit: '10',
    });
    expect(result.success).toBe(true);
  });
});

describe('DispatchesListResponseSchema', () => {
  it('accepts an empty page', () => {
    expect(
      DispatchesListResponseSchema.safeParse({ dispatches: [], nextCursor: null }).success,
    ).toBe(true);
  });

  it('accepts a paged response', () => {
    const result = DispatchesListResponseSchema.safeParse({
      dispatches: [],
      nextCursor: 'opaque-cursor',
    });
    expect(result.success).toBe(true);
  });
});
