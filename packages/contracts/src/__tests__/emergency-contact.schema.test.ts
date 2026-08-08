import { describe, expect, it } from 'vitest';

import {
  CreateEmergencyContactRequestSchema,
  EMERGENCY_CONTACT_NAME_MAX_LENGTH,
  EMERGENCY_CONTACT_NOTES_MAX_LENGTH,
  EMERGENCY_CONTACT_PRIORITY_MAX,
  EMERGENCY_CONTACT_PRIORITY_MIN,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
  EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD,
  EmergencyContactSchema,
  EmergencyContactsListResponseSchema,
  UpdateEmergencyContactRequestSchema,
} from '../http/emergency-contact.schema';

const validContact = {
  id: 'ec_abc',
  householdId: 'hh_abc',
  name: 'Alice Schwartz',
  relationship: 'Adult daughter, decision-maker',
  phone: '+14155551212',
  email: 'alice@example.com',
  priority: 1,
  notes: 'Cell only — works night shift, prefer texts before 7am or after 6pm.',
  createdAt: '2026-05-10T12:00:00.000Z',
  updatedAt: '2026-05-10T12:00:00.000Z',
};

describe('EmergencyContactSchema', () => {
  it('round-trips a fully-populated payload', () => {
    expect(EmergencyContactSchema.parse(validContact)).toEqual(validContact);
  });

  it('requires the audit + identifier fields', () => {
    const { createdAt: _c, ...withoutCreatedAt } = validContact;
    void _c;
    expect(EmergencyContactSchema.safeParse(withoutCreatedAt).success).toBe(false);
    const { id: _id, ...withoutId } = validContact;
    void _id;
    expect(EmergencyContactSchema.safeParse(withoutId).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(EmergencyContactSchema.safeParse({ ...validContact, surprise: 'field' }).success).toBe(
      false,
    );
  });

  it('rejects malformed phone numbers', () => {
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, phone: '415-555-1212' }).success,
    ).toBe(false);
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, phone: '+0123456789' }).success,
    ).toBe(false);
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, phone: 'not-a-number' }).success,
    ).toBe(false);
  });

  it('accepts E.164 phone with and without leading +', () => {
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, phone: '14155551212' }).success,
    ).toBe(true);
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, phone: '+14155551212' }).success,
    ).toBe(true);
  });

  it('allows email = null but rejects malformed emails', () => {
    expect(EmergencyContactSchema.parse({ ...validContact, email: null }).email).toBeNull();
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, email: 'not-an-email' }).success,
    ).toBe(false);
  });

  it('allows notes = null', () => {
    expect(EmergencyContactSchema.parse({ ...validContact, notes: null }).notes).toBeNull();
  });

  it('enforces priority range', () => {
    expect(
      EmergencyContactSchema.safeParse({
        ...validContact,
        priority: EMERGENCY_CONTACT_PRIORITY_MIN - 1,
      }).success,
    ).toBe(false);
    expect(
      EmergencyContactSchema.safeParse({
        ...validContact,
        priority: EMERGENCY_CONTACT_PRIORITY_MAX + 1,
      }).success,
    ).toBe(false);
    expect(EmergencyContactSchema.safeParse({ ...validContact, priority: 3.5 }).success).toBe(
      false,
    );
  });

  it('enforces field-length caps', () => {
    const oversizedName = 'a'.repeat(EMERGENCY_CONTACT_NAME_MAX_LENGTH + 1);
    expect(EmergencyContactSchema.safeParse({ ...validContact, name: oversizedName }).success).toBe(
      false,
    );
    const oversizedRelationship = 'r'.repeat(EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH + 1);
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, relationship: oversizedRelationship })
        .success,
    ).toBe(false);
    const oversizedNotes = 'n'.repeat(EMERGENCY_CONTACT_NOTES_MAX_LENGTH + 1);
    expect(
      EmergencyContactSchema.safeParse({ ...validContact, notes: oversizedNotes }).success,
    ).toBe(false);
  });

  it('rejects empty name / relationship strings', () => {
    expect(EmergencyContactSchema.safeParse({ ...validContact, name: '' }).success).toBe(false);
    expect(EmergencyContactSchema.safeParse({ ...validContact, relationship: '' }).success).toBe(
      false,
    );
  });
});

describe('CreateEmergencyContactRequestSchema', () => {
  it('rejects server-owned fields', () => {
    expect(
      CreateEmergencyContactRequestSchema.safeParse({
        name: 'A',
        relationship: 'B',
        phone: '+14155551212',
        priority: 1,
        id: 'ec_should_be_server_issued',
      }).success,
    ).toBe(false);
    expect(
      CreateEmergencyContactRequestSchema.safeParse({
        name: 'A',
        relationship: 'B',
        phone: '+14155551212',
        priority: 1,
        createdAt: '2026-05-10T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('accepts a minimal valid request', () => {
    const parsed = CreateEmergencyContactRequestSchema.parse({
      name: 'Alice',
      relationship: 'Daughter',
      phone: '+14155551212',
      priority: 1,
    });
    expect(parsed.email).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it('accepts an explicit null email / notes', () => {
    const parsed = CreateEmergencyContactRequestSchema.parse({
      name: 'Alice',
      relationship: 'Daughter',
      phone: '+14155551212',
      priority: 1,
      email: null,
      notes: null,
    });
    expect(parsed.email).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it('requires the four mandatory fields', () => {
    expect(
      CreateEmergencyContactRequestSchema.safeParse({
        name: 'A',
        relationship: 'B',
        priority: 1,
      }).success,
    ).toBe(false);
  });
});

describe('UpdateEmergencyContactRequestSchema', () => {
  it('accepts a partial update', () => {
    const parsed = UpdateEmergencyContactRequestSchema.parse({ priority: 2 });
    expect(parsed.priority).toBe(2);
    expect(parsed.name).toBeUndefined();
  });

  it('accepts the empty object at the contract layer (service rejects)', () => {
    // The contract permits `{}` because Zod has no good way to express
    // "at least one field must be present" without bloating the schema.
    // EmergencyContactsService.update enforces non-emptiness with a clean
    // 422 — the contract acts as a syntactic gate only.
    expect(UpdateEmergencyContactRequestSchema.parse({})).toEqual({});
  });

  it('rejects unknown fields', () => {
    expect(UpdateEmergencyContactRequestSchema.safeParse({ surprise: 'x' }).success).toBe(false);
  });

  it('allows clearing email / notes with explicit null', () => {
    const parsed = UpdateEmergencyContactRequestSchema.parse({ email: null, notes: null });
    expect(parsed.email).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it('enforces phone E.164 if present', () => {
    expect(UpdateEmergencyContactRequestSchema.safeParse({ phone: '415-555-1212' }).success).toBe(
      false,
    );
  });
});

describe('EmergencyContactsListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(EmergencyContactsListResponseSchema.parse({ contacts: [] })).toEqual({ contacts: [] });
  });

  it('accepts multiple contacts in priority order', () => {
    const parsed = EmergencyContactsListResponseSchema.parse({
      contacts: [
        validContact,
        { ...validContact, id: 'ec_def', priority: 2, name: 'Bob Schwartz' },
      ],
    });
    expect(parsed.contacts).toHaveLength(2);
  });

  it('rejects an unknown top-level field', () => {
    expect(
      EmergencyContactsListResponseSchema.safeParse({ contacts: [], cursor: 'x' }).success,
    ).toBe(false);
  });
});

describe('EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD', () => {
  it('is a documented stable cap', () => {
    // Contract callers (frontend list-cap warning UX, partner integrations)
    // rely on this constant. Anchoring it here catches accidental tightening
    // that would break a working family-dashboard build.
    expect(EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD).toBe(10);
  });
});
