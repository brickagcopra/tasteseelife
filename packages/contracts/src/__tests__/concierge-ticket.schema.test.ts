import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_TICKET_BODY_MAX_LENGTH,
  CONCIERGE_TICKET_LIST_LIMIT_DEFAULT,
  CONCIERGE_TICKET_LIST_LIMIT_MAX,
  CONCIERGE_TICKET_PARTY_SIZE_MAX,
  CONCIERGE_TICKET_PARTY_SIZE_MIN,
  CONCIERGE_TICKET_SLA_HOURS_BY_KIND,
  CONCIERGE_TICKET_SUBJECT_MAX_LENGTH,
  ConciergeTicketRecordSchema,
  ConciergeTicketsListResponseSchema,
  FamilySubmittableConciergeTicketKindSchema,
  ListMyConciergeRequestsQuerySchema,
  SubmitConciergeRequestRequestSchema,
  SubmitConciergeRequestResponseSchema,
  resolveConciergeTicketSlaHours,
  type ConciergeTicketKind,
} from '../http/concierge-ticket.schema';

const T0 = '2026-06-01T09:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tk_1',
    householdId: 'hh_1',
    kind: 'holiday_dinner',
    status: 'assigned',
    subject: 'Thanksgiving supper for Mom',
    body: 'A small traditional turkey dinner with her favourite chestnut stuffing.',
    requestedDate: '2026-11-26',
    partySize: 6,
    theme: 'Traditional Thanksgiving',
    slaDueAt: T0,
    assignedToUserId: 'user_primary',
    escalationPath: 'standard',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('FamilySubmittableConciergeTicketKindSchema', () => {
  it('accepts the PRD §6.6 catalog kinds', () => {
    for (const kind of [
      'custom_request',
      'holiday_dinner',
      'birthday_experience',
      'grocery_stocking',
      'tea_social',
      'museum_outing',
      'memory_meal',
    ]) {
      expect(FamilySubmittableConciergeTicketKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects transportation + emergency (their own surfaces)', () => {
    expect(FamilySubmittableConciergeTicketKindSchema.safeParse('transportation').success).toBe(
      false,
    );
    expect(
      FamilySubmittableConciergeTicketKindSchema.safeParse('emergency_assistance').success,
    ).toBe(false);
  });
});

describe('resolveConciergeTicketSlaHours / CONCIERGE_TICKET_SLA_HOURS_BY_KIND', () => {
  it('returns a positive integer for every kind', () => {
    const kinds: ConciergeTicketKind[] = [
      'custom_request',
      'holiday_dinner',
      'birthday_experience',
      'grocery_stocking',
      'tea_social',
      'museum_outing',
      'memory_meal',
      'transportation',
      'emergency_assistance',
    ];
    for (const kind of kinds) {
      const hours = resolveConciergeTicketSlaHours(kind);
      expect(Number.isInteger(hours)).toBe(true);
      expect(hours).toBeGreaterThan(0);
    }
  });

  it('gives emergency the tightest budget and occasion-planning the longest', () => {
    expect(CONCIERGE_TICKET_SLA_HOURS_BY_KIND.emergency_assistance).toBe(1);
    expect(CONCIERGE_TICKET_SLA_HOURS_BY_KIND.holiday_dinner).toBe(72);
    expect(CONCIERGE_TICKET_SLA_HOURS_BY_KIND.grocery_stocking).toBeLessThan(
      CONCIERGE_TICKET_SLA_HOURS_BY_KIND.holiday_dinner,
    );
  });
});

describe('SubmitConciergeRequestRequestSchema', () => {
  it('accepts a minimal request (kind + subject + body)', () => {
    const parsed = SubmitConciergeRequestRequestSchema.safeParse({
      kind: 'custom_request',
      subject: 'A quiet birthday tea',
      body: 'Mom turns 88 next week — could we arrange a small afternoon tea?',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the optional structured fields', () => {
    const parsed = SubmitConciergeRequestRequestSchema.safeParse({
      kind: 'birthday_experience',
      subject: 'Birthday dinner',
      body: 'Italian themed dinner for eight.',
      requestedDate: '2026-07-04',
      partySize: 8,
      theme: 'Italian',
    });
    expect(parsed.success).toBe(true);
  });

  it('trims subject + body', () => {
    const parsed = SubmitConciergeRequestRequestSchema.safeParse({
      kind: 'custom_request',
      subject: '  Tea social  ',
      body: '  Please arrange a tea social.  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subject).toBe('Tea social');
      expect(parsed.data.body).toBe('Please arrange a tea social.');
    }
  });

  it('rejects an empty subject / body', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: '   ',
        body: 'something',
      }).success,
    ).toBe(false);
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'something',
        body: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-family-submittable kind', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'emergency_assistance',
        subject: 'help',
        body: 'help',
      }).success,
    ).toBe(false);
  });

  it('rejects an over-length subject / body', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'x'.repeat(CONCIERGE_TICKET_SUBJECT_MAX_LENGTH + 1),
        body: 'ok',
      }).success,
    ).toBe(false);
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'ok',
        body: 'x'.repeat(CONCIERGE_TICKET_BODY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'ok',
        body: 'ok',
        priority: 'urgent',
      }).success,
    ).toBe(false);
  });

  it('rejects a party size outside bounds', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'ok',
        body: 'ok',
        partySize: CONCIERGE_TICKET_PARTY_SIZE_MIN - 1,
      }).success,
    ).toBe(false);
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'ok',
        body: 'ok',
        partySize: CONCIERGE_TICKET_PARTY_SIZE_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed or unreal requestedDate', () => {
    for (const bad of ['2026/11/26', '26-11-2026', '2026-13-01', '2026-02-30', 'soon']) {
      expect(
        SubmitConciergeRequestRequestSchema.safeParse({
          kind: 'custom_request',
          subject: 'ok',
          body: 'ok',
          requestedDate: bad,
        }).success,
        `expected ${bad} to be rejected`,
      ).toBe(false);
    }
  });

  it('accepts a real leap-day requestedDate', () => {
    expect(
      SubmitConciergeRequestRequestSchema.safeParse({
        kind: 'custom_request',
        subject: 'ok',
        body: 'ok',
        requestedDate: '2028-02-29',
      }).success,
    ).toBe(true);
  });
});

describe('ConciergeTicketRecordSchema', () => {
  it('accepts a fully-populated record', () => {
    expect(ConciergeTicketRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts null structured fields + null assignee (open queue)', () => {
    const parsed = ConciergeTicketRecordSchema.safeParse(
      validRecord({
        status: 'open',
        assignedToUserId: null,
        slaDueAt: null,
        requestedDate: null,
        partySize: null,
        theme: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('allows any persisted kind, including non-family-submittable ones', () => {
    expect(
      ConciergeTicketRecordSchema.safeParse(validRecord({ kind: 'emergency_assistance' })).success,
    ).toBe(true);
    expect(
      ConciergeTicketRecordSchema.safeParse(validRecord({ kind: 'transportation' })).success,
    ).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(ConciergeTicketRecordSchema.safeParse(validRecord({ extra: true })).success).toBe(false);
  });

  it('rejects an invalid status / escalation path', () => {
    expect(ConciergeTicketRecordSchema.safeParse(validRecord({ status: 'pending' })).success).toBe(
      false,
    );
    expect(
      ConciergeTicketRecordSchema.safeParse(validRecord({ escalationPath: 'nowhere' })).success,
    ).toBe(false);
  });
});

describe('SubmitConciergeRequestResponseSchema', () => {
  it('wraps a ticket record', () => {
    expect(SubmitConciergeRequestResponseSchema.safeParse({ ticket: validRecord() }).success).toBe(
      true,
    );
  });
});

describe('ConciergeTicketsListResponseSchema', () => {
  it('accepts an array of records', () => {
    expect(
      ConciergeTicketsListResponseSchema.safeParse({ tickets: [validRecord(), validRecord()] })
        .success,
    ).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(ConciergeTicketsListResponseSchema.safeParse({ tickets: [] }).success).toBe(true);
  });
});

describe('ListMyConciergeRequestsQuerySchema', () => {
  it('defaults the limit when omitted', () => {
    const parsed = ListMyConciergeRequestsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(CONCIERGE_TICKET_LIST_LIMIT_DEFAULT);
    }
  });

  it('coerces a string limit', () => {
    const parsed = ListMyConciergeRequestsQuerySchema.safeParse({ limit: '10' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(10);
    }
  });

  it('rejects a limit over the cap', () => {
    expect(
      ListMyConciergeRequestsQuerySchema.safeParse({ limit: CONCIERGE_TICKET_LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });
});
