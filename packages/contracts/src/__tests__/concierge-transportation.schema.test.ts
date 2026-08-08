import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_RIDE_STATUS_TRANSITIONS,
  CONCIERGE_RIDE_TERMINAL_STATUSES,
  CONCIERGE_RIDES_LIST_LIMIT_DEFAULT,
  CONCIERGE_RIDES_LIST_LIMIT_MAX,
  ConciergeRideStatusSchema,
  ConciergeRideStatusWebhookEventSchema,
  ConciergeRideStatusWebhookResponseSchema,
  ConciergeTransportationListResponseSchema,
  ConciergeTransportationProviderSchema,
  ConciergeTransportationRequestRecordSchema,
  InitialConciergeRideStatusSchema,
  ListConciergeTransportationQuerySchema,
  ScheduleConciergeTransportationRequestSchema,
  UpdateConciergeTransportationRequestSchema,
  canTransitionConciergeRide,
  isConciergeRideTerminal,
  type ConciergeRideStatus,
} from '../http/concierge-transportation.schema';

const PICKUP = '2026-06-01T14:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ride_1',
    householdId: 'hh_1',
    ticketId: 'tk_1',
    status: 'scheduled',
    externalProvider: 'uber_health',
    pickupAddress: '101 Park Ave, New York, NY',
    dropoffAddress: 'Mount Sinai, 1 Gustave L. Levy Pl',
    scheduledPickupAt: PICKUP,
    purpose: 'Cardiology follow-up',
    riderName: 'Eleanor',
    externalReference: 'uber_ride_99',
    externalStatus: 'accepted',
    notes: 'Wheelchair-accessible vehicle.',
    createdByUserId: 'user_concierge',
    createdAt: PICKUP,
    updatedAt: PICKUP,
    ...overrides,
  };
}

function validSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdId: 'hh_1',
    pickupAddress: '101 Park Ave',
    dropoffAddress: 'Mount Sinai',
    scheduledPickupAt: PICKUP,
    ...overrides,
  };
}

describe('ConciergeRideStatusSchema', () => {
  it('accepts the five lifecycle states', () => {
    for (const status of ['requested', 'scheduled', 'in_progress', 'completed', 'canceled']) {
      expect(ConciergeRideStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects an unknown status', () => {
    expect(ConciergeRideStatusSchema.safeParse('arriving').success).toBe(false);
  });
});

describe('ConciergeTransportationProviderSchema', () => {
  it('accepts the manual + two vendor providers', () => {
    for (const p of ['manual', 'uber_health', 'lyft_health']) {
      expect(ConciergeTransportationProviderSchema.parse(p)).toBe(p);
    }
  });

  it('rejects an unknown provider', () => {
    expect(ConciergeTransportationProviderSchema.safeParse('curb').success).toBe(false);
  });
});

describe('InitialConciergeRideStatusSchema', () => {
  it('accepts only the two non-terminal entry states', () => {
    expect(InitialConciergeRideStatusSchema.parse('requested')).toBe('requested');
    expect(InitialConciergeRideStatusSchema.parse('scheduled')).toBe('scheduled');
  });

  it('rejects in_progress / completed / canceled at schedule time', () => {
    for (const s of ['in_progress', 'completed', 'canceled']) {
      expect(InitialConciergeRideStatusSchema.safeParse(s).success).toBe(false);
    }
  });
});

describe('ride status-transition policy', () => {
  it('matrix matches the documented lifecycle', () => {
    expect(CONCIERGE_RIDE_STATUS_TRANSITIONS.requested).toEqual([
      'scheduled',
      'in_progress',
      'canceled',
    ]);
    expect(CONCIERGE_RIDE_STATUS_TRANSITIONS.scheduled).toEqual(['in_progress', 'canceled']);
    expect(CONCIERGE_RIDE_STATUS_TRANSITIONS.in_progress).toEqual(['completed', 'canceled']);
    expect(CONCIERGE_RIDE_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(CONCIERGE_RIDE_STATUS_TRANSITIONS.canceled).toEqual([]);
  });

  it('canTransitionConciergeRide reflects the matrix', () => {
    expect(canTransitionConciergeRide('requested', 'scheduled')).toBe(true);
    expect(canTransitionConciergeRide('requested', 'in_progress')).toBe(true);
    expect(canTransitionConciergeRide('scheduled', 'completed')).toBe(false);
    expect(canTransitionConciergeRide('completed', 'requested')).toBe(false);
  });

  it('isConciergeRideTerminal flags completed + canceled only', () => {
    expect(CONCIERGE_RIDE_TERMINAL_STATUSES).toEqual(['completed', 'canceled']);
    const terminal: ConciergeRideStatus[] = ['completed', 'canceled'];
    const live: ConciergeRideStatus[] = ['requested', 'scheduled', 'in_progress'];
    for (const s of terminal) expect(isConciergeRideTerminal(s)).toBe(true);
    for (const s of live) expect(isConciergeRideTerminal(s)).toBe(false);
  });
});

describe('ConciergeTransportationRequestRecordSchema', () => {
  it('parses a full valid record', () => {
    expect(ConciergeTransportationRequestRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts null for every nullable field', () => {
    const record = validRecord({
      ticketId: null,
      purpose: null,
      riderName: null,
      externalReference: null,
      externalStatus: null,
      notes: null,
    });
    expect(ConciergeTransportationRequestRecordSchema.safeParse(record).success).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      ConciergeTransportationRequestRecordSchema.safeParse(validRecord({ surge: 1.5 })).success,
    ).toBe(false);
  });

  it('rejects a non-offset timestamp', () => {
    expect(
      ConciergeTransportationRequestRecordSchema.safeParse(
        validRecord({ scheduledPickupAt: 'not-a-date' }),
      ).success,
    ).toBe(false);
  });
});

describe('ScheduleConciergeTransportationRequestSchema', () => {
  it('defaults status to requested and provider to manual', () => {
    const parsed = ScheduleConciergeTransportationRequestSchema.parse(validSchedule());
    expect(parsed.status).toBe('requested');
    expect(parsed.externalProvider).toBe('manual');
  });

  it('accepts an explicit scheduled status + vendor provider + reference', () => {
    const parsed = ScheduleConciergeTransportationRequestSchema.parse(
      validSchedule({
        status: 'scheduled',
        externalProvider: 'lyft_health',
        externalReference: 'lyft_1',
      }),
    );
    expect(parsed.status).toBe('scheduled');
    expect(parsed.externalProvider).toBe('lyft_health');
    expect(parsed.externalReference).toBe('lyft_1');
  });

  it('requires pickup + dropoff + scheduledPickupAt', () => {
    expect(
      ScheduleConciergeTransportationRequestSchema.safeParse({ householdId: 'hh_1' }).success,
    ).toBe(false);
  });

  it('rejects in_progress as an initial status', () => {
    expect(
      ScheduleConciergeTransportationRequestSchema.safeParse(
        validSchedule({ status: 'in_progress' }),
      ).success,
    ).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      ScheduleConciergeTransportationRequestSchema.safeParse(validSchedule({ tipPercent: 20 }))
        .success,
    ).toBe(false);
  });
});

describe('UpdateConciergeTransportationRequestSchema', () => {
  it('accepts a partial update', () => {
    expect(
      UpdateConciergeTransportationRequestSchema.safeParse({ status: 'in_progress' }).success,
    ).toBe(true);
  });

  it('accepts null to clear nullable fields', () => {
    expect(
      UpdateConciergeTransportationRequestSchema.safeParse({ purpose: null, notes: null }).success,
    ).toBe(true);
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateConciergeTransportationRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects clearing a non-nullable field (pickupAddress)', () => {
    expect(
      UpdateConciergeTransportationRequestSchema.safeParse({ pickupAddress: null }).success,
    ).toBe(false);
  });
});

describe('ListConciergeTransportationQuerySchema', () => {
  it('defaults the limit and coerces upcomingOnly', () => {
    const parsed = ListConciergeTransportationQuerySchema.parse({ upcomingOnly: 'true' });
    expect(parsed.limit).toBe(CONCIERGE_RIDES_LIST_LIMIT_DEFAULT);
    expect(parsed.upcomingOnly).toBe(true);
  });

  it('coerces a string limit and rejects over the max', () => {
    expect(ListConciergeTransportationQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(
      ListConciergeTransportationQuerySchema.safeParse({
        limit: String(CONCIERGE_RIDES_LIST_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown query param (strict)', () => {
    expect(ListConciergeTransportationQuerySchema.safeParse({ surgeOnly: 'true' }).success).toBe(
      false,
    );
  });
});

describe('ConciergeTransportationListResponseSchema', () => {
  it('wraps an array of records', () => {
    const parsed = ConciergeTransportationListResponseSchema.parse({ requests: [validRecord()] });
    expect(parsed.requests).toHaveLength(1);
  });
});

describe('ConciergeRideStatusWebhookEventSchema', () => {
  const event = {
    externalProvider: 'uber_health',
    externalReference: 'uber_ride_1',
    externalStatus: 'arriving',
    occurredAt: PICKUP,
  };

  it('parses a valid inbound webhook event', () => {
    expect(ConciergeRideStatusWebhookEventSchema.safeParse(event).success).toBe(true);
  });

  it('still accepts a manual provider at the schema level (the controller rejects it)', () => {
    expect(
      ConciergeRideStatusWebhookEventSchema.safeParse({ ...event, externalProvider: 'manual' })
        .success,
    ).toBe(true);
  });

  it('requires every field (no defaults)', () => {
    expect(
      ConciergeRideStatusWebhookEventSchema.safeParse({ externalProvider: 'uber_health' }).success,
    ).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(ConciergeRideStatusWebhookEventSchema.safeParse({ ...event, lat: 40.7 }).success).toBe(
      false,
    );
  });
});

describe('ConciergeRideStatusWebhookResponseSchema', () => {
  it('parses each outcome with a nullable status', () => {
    expect(
      ConciergeRideStatusWebhookResponseSchema.safeParse({
        received: true,
        outcome: 'applied',
        status: 'in_progress',
      }).success,
    ).toBe(true);
    expect(
      ConciergeRideStatusWebhookResponseSchema.safeParse({
        received: true,
        outcome: 'not_found',
        status: null,
      }).success,
    ).toBe(true);
  });

  it('rejects received: false', () => {
    expect(
      ConciergeRideStatusWebhookResponseSchema.safeParse({
        received: false,
        outcome: 'applied',
        status: null,
      }).success,
    ).toBe(false);
  });
});
