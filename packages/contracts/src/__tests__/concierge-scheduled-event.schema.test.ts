import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_EVENT_STATUS_TRANSITIONS,
  CONCIERGE_EVENT_TERMINAL_STATUSES,
  CONCIERGE_EVENT_TITLE_MAX_LENGTH,
  CONCIERGE_EVENTS_LIST_LIMIT_DEFAULT,
  CONCIERGE_EVENTS_LIST_LIMIT_MAX,
  ConciergeEventKindSchema,
  ConciergeEventStatusSchema,
  ConciergeScheduledEventRecordSchema,
  ConciergeScheduledEventsListResponseSchema,
  ListConciergeScheduledEventsQuerySchema,
  ScheduleConciergeEventRequestSchema,
  ScheduleConciergeEventResponseSchema,
  UpdateConciergeEventRequestSchema,
  canTransitionConciergeEvent,
  isConciergeEventTerminal,
  type ConciergeEventStatus,
} from '../http/concierge-scheduled-event.schema';

const START = '2026-06-01T18:00:00.000Z';
const END = '2026-06-01T20:30:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev_1',
    householdId: 'hh_1',
    ticketId: 'tk_1',
    kind: 'restaurant_reservation',
    status: 'confirmed',
    title: 'Sunday lunch at Carbone',
    venueName: 'Carbone',
    venueAddress: '181 Thompson St, New York, NY',
    scheduledStart: START,
    scheduledEnd: END,
    partySize: 4,
    externalProvider: 'opentable',
    externalReference: 'OT-998877',
    notes: 'Window table; wheelchair access needed.',
    createdByUserId: 'user_concierge',
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function validSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdId: 'hh_1',
    kind: 'cultural_event',
    title: 'MoMA private tour',
    scheduledStart: START,
    ...overrides,
  };
}

describe('ConciergeEventKindSchema', () => {
  it('accepts the three Tier-3 experience kinds', () => {
    for (const kind of ['restaurant_reservation', 'cultural_event', 'group_outing']) {
      expect(ConciergeEventKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects an unknown kind', () => {
    expect(ConciergeEventKindSchema.safeParse('spa_day').success).toBe(false);
  });
});

describe('ConciergeEventStatusSchema', () => {
  it('accepts the four lifecycle states', () => {
    for (const status of ['proposed', 'confirmed', 'completed', 'canceled']) {
      expect(ConciergeEventStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('status-transition policy', () => {
  it('allows proposed → confirmed / canceled', () => {
    expect(canTransitionConciergeEvent('proposed', 'confirmed')).toBe(true);
    expect(canTransitionConciergeEvent('proposed', 'canceled')).toBe(true);
  });

  it('allows confirmed → completed / canceled', () => {
    expect(canTransitionConciergeEvent('confirmed', 'completed')).toBe(true);
    expect(canTransitionConciergeEvent('confirmed', 'canceled')).toBe(true);
  });

  it('forbids skipping proposed → completed', () => {
    expect(canTransitionConciergeEvent('proposed', 'completed')).toBe(false);
  });

  it('forbids any transition out of a terminal state', () => {
    for (const from of CONCIERGE_EVENT_TERMINAL_STATUSES) {
      for (const to of ['proposed', 'confirmed', 'completed', 'canceled'] as const) {
        expect(canTransitionConciergeEvent(from, to)).toBe(false);
      }
    }
  });

  it('marks completed + canceled terminal and the rest non-terminal', () => {
    expect(isConciergeEventTerminal('completed')).toBe(true);
    expect(isConciergeEventTerminal('canceled')).toBe(true);
    expect(isConciergeEventTerminal('proposed')).toBe(false);
    expect(isConciergeEventTerminal('confirmed')).toBe(false);
  });

  it('keeps the matrix in lockstep with the status enum (every status keyed)', () => {
    const statuses: readonly ConciergeEventStatus[] = [
      'proposed',
      'confirmed',
      'completed',
      'canceled',
    ];
    for (const status of statuses) {
      expect(CONCIERGE_EVENT_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe('ConciergeScheduledEventRecordSchema', () => {
  it('accepts a fully-populated record', () => {
    expect(ConciergeScheduledEventRecordSchema.parse(validRecord())).toMatchObject({
      id: 'ev_1',
      kind: 'restaurant_reservation',
      externalProvider: 'opentable',
    });
  });

  it('accepts null nullable fields (concierge-initiated, no venue/end/ref)', () => {
    const parsed = ConciergeScheduledEventRecordSchema.parse(
      validRecord({
        ticketId: null,
        venueName: null,
        venueAddress: null,
        scheduledEnd: null,
        partySize: null,
        externalReference: null,
        notes: null,
        externalProvider: 'manual',
      }),
    );
    expect(parsed.ticketId).toBeNull();
    expect(parsed.scheduledEnd).toBeNull();
  });

  it('rejects unknown fields (strict)', () => {
    expect(ConciergeScheduledEventRecordSchema.safeParse(validRecord({ extra: 1 })).success).toBe(
      false,
    );
  });

  it('rejects a non-offset datetime for scheduledStart', () => {
    expect(
      ConciergeScheduledEventRecordSchema.safeParse(validRecord({ scheduledStart: '2026-06-01' }))
        .success,
    ).toBe(false);
  });
});

describe('ScheduleConciergeEventRequestSchema', () => {
  it('accepts a minimal schedule + applies defaults', () => {
    const parsed = ScheduleConciergeEventRequestSchema.parse(validSchedule());
    expect(parsed.status).toBe('proposed');
    expect(parsed.externalProvider).toBe('manual');
  });

  it('accepts an explicit confirmed initial status', () => {
    expect(
      ScheduleConciergeEventRequestSchema.parse(validSchedule({ status: 'confirmed' })).status,
    ).toBe('confirmed');
  });

  it('rejects an initial status of completed or canceled', () => {
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(validSchedule({ status: 'completed' })).success,
    ).toBe(false);
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(validSchedule({ status: 'canceled' })).success,
    ).toBe(false);
  });

  it('requires a householdId', () => {
    const { householdId: _omit, ...rest } = validSchedule();
    expect(ScheduleConciergeEventRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects scheduledEnd at or before scheduledStart', () => {
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(
        validSchedule({ scheduledStart: END, scheduledEnd: START }),
      ).success,
    ).toBe(false);
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(
        validSchedule({ scheduledStart: START, scheduledEnd: START }),
      ).success,
    ).toBe(false);
  });

  it('accepts scheduledEnd after scheduledStart', () => {
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(
        validSchedule({ scheduledStart: START, scheduledEnd: END }),
      ).success,
    ).toBe(true);
  });

  it('rejects a title past the cap and unknown fields', () => {
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(
        validSchedule({ title: 'x'.repeat(CONCIERGE_EVENT_TITLE_MAX_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(
      ScheduleConciergeEventRequestSchema.safeParse(validSchedule({ surprise: 1 })).success,
    ).toBe(false);
  });
});

describe('ScheduleConciergeEventResponseSchema', () => {
  it('wraps the record under `event`', () => {
    expect(ScheduleConciergeEventResponseSchema.parse({ event: validRecord() }).event.id).toBe(
      'ev_1',
    );
  });
});

describe('UpdateConciergeEventRequestSchema', () => {
  it('accepts a single-field partial', () => {
    expect(UpdateConciergeEventRequestSchema.parse({ status: 'confirmed' }).status).toBe(
      'confirmed',
    );
  });

  it('rejects an empty body', () => {
    expect(UpdateConciergeEventRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts null to clear nullable fields', () => {
    const parsed = UpdateConciergeEventRequestSchema.parse({
      venueName: null,
      scheduledEnd: null,
      notes: null,
    });
    expect(parsed.venueName).toBeNull();
    expect(parsed.scheduledEnd).toBeNull();
  });

  it('rejects a kind edit (kind is not mutable)', () => {
    expect(UpdateConciergeEventRequestSchema.safeParse({ kind: 'group_outing' }).success).toBe(
      false,
    );
  });

  it('rejects scheduledEnd at/before scheduledStart when both supplied', () => {
    expect(
      UpdateConciergeEventRequestSchema.safeParse({ scheduledStart: END, scheduledEnd: START })
        .success,
    ).toBe(false);
  });

  it('allows clearing scheduledEnd while moving scheduledStart', () => {
    expect(
      UpdateConciergeEventRequestSchema.safeParse({ scheduledStart: END, scheduledEnd: null })
        .success,
    ).toBe(true);
  });
});

describe('ListConciergeScheduledEventsQuerySchema', () => {
  it('defaults limit and leaves filters unset', () => {
    const parsed = ListConciergeScheduledEventsQuerySchema.parse({});
    expect(parsed.limit).toBe(CONCIERGE_EVENTS_LIST_LIMIT_DEFAULT);
    expect(parsed.householdId).toBeUndefined();
  });

  it('coerces limit + upcomingOnly from strings', () => {
    const parsed = ListConciergeScheduledEventsQuerySchema.parse({
      limit: '10',
      upcomingOnly: 'true',
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.upcomingOnly).toBe(true);
  });

  it('rejects a limit past the max', () => {
    expect(
      ListConciergeScheduledEventsQuerySchema.safeParse({
        limit: String(CONCIERGE_EVENTS_LIST_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown query params (strict)', () => {
    expect(ListConciergeScheduledEventsQuerySchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('ConciergeScheduledEventsListResponseSchema', () => {
  it('accepts an array of records', () => {
    const parsed = ConciergeScheduledEventsListResponseSchema.parse({ events: [validRecord()] });
    expect(parsed.events).toHaveLength(1);
  });

  it('accepts an empty list', () => {
    expect(ConciergeScheduledEventsListResponseSchema.parse({ events: [] }).events).toHaveLength(0);
  });
});
