import { describe, expect, it } from 'vitest';

import {
  CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH,
  ConciergeEmergencyCategorySchema,
  TriggerEmergencyAssistanceRequestSchema,
  TriggerEmergencyAssistanceResponseSchema,
} from '../http/concierge-emergency.schema';

const T0 = '2026-06-01T09:00:00.000Z';

function validEmergencyTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tk_emergency_1',
    householdId: 'hh_1',
    kind: 'emergency_assistance',
    status: 'escalated',
    subject: 'Emergency assistance — Medical concern',
    body: "Mom isn't answering the door and was expecting us.",
    requestedDate: null,
    partySize: null,
    theme: null,
    slaDueAt: T0,
    assignedToUserId: 'user_primary',
    escalationPath: 'emergency_on_call',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('ConciergeEmergencyCategorySchema', () => {
  it('accepts the four triage categories', () => {
    for (const category of ['medical', 'safety', 'urgent_need', 'other']) {
      expect(ConciergeEmergencyCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(ConciergeEmergencyCategorySchema.safeParse('fire').success).toBe(false);
    expect(ConciergeEmergencyCategorySchema.safeParse('').success).toBe(false);
  });
});

describe('TriggerEmergencyAssistanceRequestSchema', () => {
  it('accepts a category-only trigger (note omitted)', () => {
    const parsed = TriggerEmergencyAssistanceRequestSchema.safeParse({ category: 'safety' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.category).toBe('safety');
      expect(parsed.data.note).toBeUndefined();
    }
  });

  it('accepts a category + note', () => {
    const parsed = TriggerEmergencyAssistanceRequestSchema.safeParse({
      category: 'medical',
      note: "Mom isn't answering the door.",
    });
    expect(parsed.success).toBe(true);
  });

  it('trims the note', () => {
    const parsed = TriggerEmergencyAssistanceRequestSchema.safeParse({
      category: 'urgent_need',
      note: '  Out of her heart medication.  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.note).toBe('Out of her heart medication.');
    }
  });

  it('rejects an empty / whitespace-only note when present', () => {
    expect(
      TriggerEmergencyAssistanceRequestSchema.safeParse({ category: 'other', note: '   ' }).success,
    ).toBe(false);
  });

  it('rejects an over-length note', () => {
    expect(
      TriggerEmergencyAssistanceRequestSchema.safeParse({
        category: 'other',
        note: 'x'.repeat(CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a missing category', () => {
    expect(TriggerEmergencyAssistanceRequestSchema.safeParse({ note: 'help' }).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      TriggerEmergencyAssistanceRequestSchema.safeParse({
        category: 'medical',
        severity: 'critical',
      }).success,
    ).toBe(false);
  });
});

describe('TriggerEmergencyAssistanceResponseSchema', () => {
  it('wraps the created escalated emergency ticket', () => {
    expect(
      TriggerEmergencyAssistanceResponseSchema.safeParse({ ticket: validEmergencyTicket() })
        .success,
    ).toBe(true);
  });

  it('accepts an unassigned (open-queue) emergency ticket', () => {
    expect(
      TriggerEmergencyAssistanceResponseSchema.safeParse({
        ticket: validEmergencyTicket({ status: 'open', assignedToUserId: null }),
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(
      TriggerEmergencyAssistanceResponseSchema.safeParse({
        ticket: validEmergencyTicket(),
        paged: true,
      }).success,
    ).toBe(false);
  });
});
