import { describe, expect, it } from 'vitest';

import {
  AddConciergeTicketNoteRequestSchema,
  AddConciergeTicketNoteResponseSchema,
  CONCIERGE_OPS_NOTE_BODY_MAX_LENGTH,
  CONCIERGE_OPS_QUEUE_LIMIT_DEFAULT,
  CONCIERGE_OPS_QUEUE_LIMIT_MAX,
  CONCIERGE_TICKET_STATUS_TRANSITIONS,
  CONCIERGE_TICKET_TERMINAL_STATUSES,
  ConciergeEscalationTargetSchema,
  ConciergeOpsTicketDetailResponseSchema,
  ConciergeOpsTicketsListResponseSchema,
  ConciergeTicketNoteRecordSchema,
  EscalateConciergeTicketRequestSchema,
  EscalateConciergeTicketResponseSchema,
  ListConciergeOpsTicketsQuerySchema,
  TransitionConciergeTicketRequestSchema,
  TransitionConciergeTicketResponseSchema,
  canTransitionConciergeTicket,
  isConciergeTicketTerminal,
} from '../http/concierge-ops.schema';
import type { ConciergeTicketStatus } from '../http/concierge-ticket.schema';

const T0 = '2026-06-01T09:00:00.000Z';

function validTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tk_1',
    householdId: 'hh_1',
    kind: 'holiday_dinner',
    status: 'open',
    subject: 'Thanksgiving supper for Mom',
    body: 'A small traditional turkey dinner.',
    requestedDate: '2026-11-26',
    partySize: 6,
    theme: 'Traditional Thanksgiving',
    slaDueAt: T0,
    assignedToUserId: null,
    escalationPath: 'standard',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function validNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note_1',
    ticketId: 'tk_1',
    authorUserId: 'user_ops',
    body: 'Reached out to the family to confirm the guest count.',
    createdAt: T0,
    ...overrides,
  };
}

describe('CONCIERGE_TICKET_STATUS_TRANSITIONS + helpers', () => {
  it('keys every status of the lifecycle', () => {
    const statuses: ConciergeTicketStatus[] = [
      'open',
      'assigned',
      'in_progress',
      'escalated',
      'resolved',
      'canceled',
    ];
    for (const s of statuses) {
      expect(CONCIERGE_TICKET_STATUS_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('never lists `escalated` as a transition target (escalation is its own action)', () => {
    for (const targets of Object.values(CONCIERGE_TICKET_STATUS_TRANSITIONS)) {
      expect((targets as readonly string[]).includes('escalated')).toBe(false);
    }
  });

  it('treats resolved + canceled as terminal (no outbound transitions)', () => {
    expect(CONCIERGE_TICKET_STATUS_TRANSITIONS.resolved).toEqual([]);
    expect(CONCIERGE_TICKET_STATUS_TRANSITIONS.canceled).toEqual([]);
    expect(isConciergeTicketTerminal('resolved')).toBe(true);
    expect(isConciergeTicketTerminal('canceled')).toBe(true);
    expect(isConciergeTicketTerminal('open')).toBe(false);
    expect(isConciergeTicketTerminal('escalated')).toBe(false);
  });

  it('canTransitionConciergeTicket reflects the matrix', () => {
    expect(canTransitionConciergeTicket('open', 'in_progress')).toBe(true);
    expect(canTransitionConciergeTicket('open', 'canceled')).toBe(true);
    expect(canTransitionConciergeTicket('assigned', 'in_progress')).toBe(true);
    expect(canTransitionConciergeTicket('in_progress', 'resolved')).toBe(true);
    expect(canTransitionConciergeTicket('escalated', 'resolved')).toBe(true);
    expect(canTransitionConciergeTicket('escalated', 'in_progress')).toBe(true);
    // Disallowed
    expect(canTransitionConciergeTicket('open', 'resolved')).toBe(false);
    expect(canTransitionConciergeTicket('open', 'assigned')).toBe(false);
    expect(canTransitionConciergeTicket('resolved', 'in_progress')).toBe(false);
    expect(canTransitionConciergeTicket('canceled', 'open')).toBe(false);
  });

  it('exposes the terminal-status tuple', () => {
    expect([...CONCIERGE_TICKET_TERMINAL_STATUSES].sort()).toEqual(['canceled', 'resolved']);
  });
});

describe('ConciergeEscalationTargetSchema', () => {
  it('accepts the actionable escalation paths', () => {
    for (const target of ['concierge_lead', 'ops_manager', 'trust_safety', 'emergency_on_call']) {
      expect(ConciergeEscalationTargetSchema.safeParse(target).success).toBe(true);
    }
  });

  it('rejects `standard` (escalating to standard would be de-escalation)', () => {
    expect(ConciergeEscalationTargetSchema.safeParse('standard').success).toBe(false);
  });
});

describe('ConciergeTicketNoteRecordSchema', () => {
  it('accepts a valid note', () => {
    expect(ConciergeTicketNoteRecordSchema.safeParse(validNote()).success).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(ConciergeTicketNoteRecordSchema.safeParse(validNote({ body: '' })).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(ConciergeTicketNoteRecordSchema.safeParse(validNote({ extra: 'nope' })).success).toBe(
      false,
    );
  });

  it('rejects a non-offset createdAt', () => {
    expect(
      ConciergeTicketNoteRecordSchema.safeParse(validNote({ createdAt: 'not-a-date' })).success,
    ).toBe(false);
  });
});

describe('ListConciergeOpsTicketsQuerySchema', () => {
  it('defaults the limit and accepts an empty query', () => {
    const parsed = ListConciergeOpsTicketsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(CONCIERGE_OPS_QUEUE_LIMIT_DEFAULT);
  });

  it('coerces a string limit and caps at the max', () => {
    expect(ListConciergeOpsTicketsQuerySchema.safeParse({ limit: '25' }).success).toBe(true);
    expect(
      ListConciergeOpsTicketsQuerySchema.safeParse({ limit: CONCIERGE_OPS_QUEUE_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('accepts the optional status / escalationPath / kind / householdId filters', () => {
    const parsed = ListConciergeOpsTicketsQuerySchema.safeParse({
      status: 'escalated',
      escalationPath: 'trust_safety',
      kind: 'memory_meal',
      householdId: 'hh_42',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(ListConciergeOpsTicketsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });

  it('rejects unknown query fields (strict)', () => {
    expect(ListConciergeOpsTicketsQuerySchema.safeParse({ sort: 'sla' }).success).toBe(false);
  });
});

describe('ConciergeOpsTicketsListResponseSchema', () => {
  it('accepts a list of tickets', () => {
    const parsed = ConciergeOpsTicketsListResponseSchema.safeParse({
      tickets: [validTicket(), validTicket({ id: 'tk_2', status: 'escalated' })],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(ConciergeOpsTicketsListResponseSchema.safeParse({ tickets: [] }).success).toBe(true);
  });
});

describe('ConciergeOpsTicketDetailResponseSchema', () => {
  it('accepts a ticket + notes timeline', () => {
    const parsed = ConciergeOpsTicketDetailResponseSchema.safeParse({
      ticket: validTicket(),
      notes: [validNote(), validNote({ id: 'note_2' })],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a ticket with no notes', () => {
    expect(
      ConciergeOpsTicketDetailResponseSchema.safeParse({ ticket: validTicket(), notes: [] })
        .success,
    ).toBe(true);
  });
});

describe('TransitionConciergeTicketRequestSchema', () => {
  it('accepts a target status with an optional note', () => {
    expect(
      TransitionConciergeTicketRequestSchema.safeParse({ targetStatus: 'in_progress' }).success,
    ).toBe(true);
    expect(
      TransitionConciergeTicketRequestSchema.safeParse({
        targetStatus: 'resolved',
        note: 'Family was delighted.',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty note', () => {
    expect(
      TransitionConciergeTicketRequestSchema.safeParse({ targetStatus: 'resolved', note: '   ' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown target status', () => {
    expect(TransitionConciergeTicketRequestSchema.safeParse({ targetStatus: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects a note past the max length', () => {
    expect(
      TransitionConciergeTicketRequestSchema.safeParse({
        targetStatus: 'resolved',
        note: 'x'.repeat(CONCIERGE_OPS_NOTE_BODY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('TransitionConciergeTicketResponseSchema', () => {
  it('wraps the updated ticket', () => {
    expect(
      TransitionConciergeTicketResponseSchema.safeParse({ ticket: validTicket() }).success,
    ).toBe(true);
  });
});

describe('EscalateConciergeTicketRequestSchema', () => {
  it('accepts an actionable escalation path with an optional note', () => {
    expect(
      EscalateConciergeTicketRequestSchema.safeParse({ escalationPath: 'concierge_lead' }).success,
    ).toBe(true);
    expect(
      EscalateConciergeTicketRequestSchema.safeParse({
        escalationPath: 'trust_safety',
        note: 'Possible welfare concern raised by family.',
      }).success,
    ).toBe(true);
  });

  it('rejects `standard` as an escalation target', () => {
    expect(
      EscalateConciergeTicketRequestSchema.safeParse({ escalationPath: 'standard' }).success,
    ).toBe(false);
  });
});

describe('EscalateConciergeTicketResponseSchema', () => {
  it('wraps the updated ticket', () => {
    expect(EscalateConciergeTicketResponseSchema.safeParse({ ticket: validTicket() }).success).toBe(
      true,
    );
  });
});

describe('AddConciergeTicketNoteRequestSchema', () => {
  it('accepts a body', () => {
    expect(
      AddConciergeTicketNoteRequestSchema.safeParse({ body: 'Confirmed with the chef.' }).success,
    ).toBe(true);
  });

  it('rejects an empty / whitespace body', () => {
    expect(AddConciergeTicketNoteRequestSchema.safeParse({ body: '' }).success).toBe(false);
    expect(AddConciergeTicketNoteRequestSchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AddConciergeTicketNoteRequestSchema.safeParse({ body: 'hi', authorUserId: 'spoofed' })
        .success,
    ).toBe(false);
  });
});

describe('AddConciergeTicketNoteResponseSchema', () => {
  it('wraps the appended note', () => {
    expect(AddConciergeTicketNoteResponseSchema.safeParse({ note: validNote() }).success).toBe(
      true,
    );
  });
});
