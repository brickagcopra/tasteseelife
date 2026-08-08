import { describe, expect, it } from 'vitest';

import {
  TRUST_SAFETY_BOOKING_HOLD_NO_SUBJECT_MESSAGE,
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
  TRUST_SAFETY_INCIDENT_CREATED,
  TrustSafetyBookingHoldReleasedSchema,
  TrustSafetyBookingHoldRequestedSchema,
  TrustSafetyIncidentCreatedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the trust & safety incident-created event (TS-301a).
 *
 * Pins the wire shape (`.strict()`), the envelope, the no-free-text
 * invariant (the report description must never ride the event), and the
 * registry wiring — so a producer edit is a parse error at the (carved)
 * TS-302 consumers.
 */
describe('trust safety event registry wiring', () => {
  it('registers the event under its dotted constant', () => {
    expect(eventRegistry[TRUST_SAFETY_INCIDENT_CREATED]).toBe(TrustSafetyIncidentCreatedSchema);
    expect(getEventSchema(TRUST_SAFETY_INCIDENT_CREATED)).toBe(TrustSafetyIncidentCreatedSchema);
  });

  it('uses a past-tense dotted name', () => {
    expect(TRUST_SAFETY_INCIDENT_CREATED).toBe('trust_safety.incident.created');
    expect(TRUST_SAFETY_INCIDENT_CREATED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('TrustSafetyIncidentCreated event', () => {
  const valid = {
    eventId: 'evt_1',
    occurredAt: '2026-07-02T12:00:00.000Z',
    incidentId: 'inc_1',
    category: 'welfare',
    severity: 'high',
    source: 'family',
    householdId: 'hh_1',
    seniorId: 'senior_1',
    openedAt: '2026-07-02T12:00:00.000Z',
    slaDueAt: '2026-07-02T20:00:00.000Z',
  };

  it('accepts a valid household-scoped payload', () => {
    expect(TrustSafetyIncidentCreatedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts null householdId / seniorId (future system-ingested sources)', () => {
    expect(
      TrustSafetyIncidentCreatedSchema.safeParse({
        ...valid,
        source: 'system',
        householdId: null,
        seniorId: null,
      }).success,
    ).toBe(true);
  });

  it('accepts every source and severity', () => {
    for (const source of ['family', 'senior', 'provider', 'concierge', 'system']) {
      expect(TrustSafetyIncidentCreatedSchema.safeParse({ ...valid, source }).success).toBe(true);
    }
    for (const severity of ['low', 'medium', 'high', 'critical']) {
      expect(TrustSafetyIncidentCreatedSchema.safeParse({ ...valid, severity }).success).toBe(true);
    }
  });

  it('rejects free-text fields — the report description never rides the event', () => {
    expect(
      TrustSafetyIncidentCreatedSchema.safeParse({ ...valid, description: 'free text' }).success,
    ).toBe(false);
    expect(
      TrustSafetyIncidentCreatedSchema.safeParse({ ...valid, resolutionNotes: 'x' }).success,
    ).toBe(false);
  });

  it('requires the envelope', () => {
    const { eventId: _eventId, ...withoutEventId } = valid;
    expect(TrustSafetyIncidentCreatedSchema.safeParse(withoutEventId).success).toBe(false);
    const { occurredAt: _occurredAt, ...withoutOccurredAt } = valid;
    expect(TrustSafetyIncidentCreatedSchema.safeParse(withoutOccurredAt).success).toBe(false);
  });
});

/**
 * Contract tests for the booking-hold pair (TS-304).
 *
 * The invariant worth a test of its own is the subject requirement: a hold
 * event with no provider / senior / household names no one, and a consumer
 * that treats "no subject" as "match everything" would freeze the platform.
 * The schema refuses that shape at producer time, so it is asserted here on
 * BOTH halves — the release path is where a lazy "just carry the incidentId"
 * refactor would most plausibly drop the subjects.
 */
describe('trust safety booking-hold event registry wiring', () => {
  it('registers both halves under their dotted constants', () => {
    expect(eventRegistry[TRUST_SAFETY_BOOKING_HOLD_REQUESTED]).toBe(
      TrustSafetyBookingHoldRequestedSchema,
    );
    expect(eventRegistry[TRUST_SAFETY_BOOKING_HOLD_RELEASED]).toBe(
      TrustSafetyBookingHoldReleasedSchema,
    );
    expect(getEventSchema(TRUST_SAFETY_BOOKING_HOLD_REQUESTED)).toBe(
      TrustSafetyBookingHoldRequestedSchema,
    );
    expect(getEventSchema(TRUST_SAFETY_BOOKING_HOLD_RELEASED)).toBe(
      TrustSafetyBookingHoldReleasedSchema,
    );
  });

  it('uses past-tense dotted names', () => {
    expect(TRUST_SAFETY_BOOKING_HOLD_REQUESTED).toBe('trust_safety.booking_hold.requested');
    expect(TRUST_SAFETY_BOOKING_HOLD_RELEASED).toBe('trust_safety.booking_hold.released');
    for (const name of [TRUST_SAFETY_BOOKING_HOLD_REQUESTED, TRUST_SAFETY_BOOKING_HOLD_RELEASED]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe('TrustSafetyBookingHoldRequested event', () => {
  const valid = {
    eventId: 'evt_hold_1',
    occurredAt: '2026-07-26T12:00:00.000Z',
    incidentId: 'inc_1',
    severity: 'high',
    category: 'welfare',
    providerId: 'prv_1',
    seniorId: 'senior_1',
    householdId: 'hh_1',
    requestedAt: '2026-07-26T12:00:00.000Z',
  };

  it('accepts a payload naming all three subjects', () => {
    expect(TrustSafetyBookingHoldRequestedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a payload naming exactly one subject', () => {
    for (const key of ['providerId', 'seniorId', 'householdId'] as const) {
      const single = {
        ...valid,
        providerId: null,
        seniorId: null,
        householdId: null,
        [key]: 'x_1',
      };
      expect(TrustSafetyBookingHoldRequestedSchema.safeParse(single).success).toBe(true);
    }
  });

  it('REJECTS a subjectless hold — the platform-wide-freeze shape', () => {
    const result = TrustSafetyBookingHoldRequestedSchema.safeParse({
      ...valid,
      providerId: null,
      seniorId: null,
      householdId: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(TRUST_SAFETY_BOOKING_HOLD_NO_SUBJECT_MESSAGE);
    }
  });

  it('requires every subject key to be present (nullable, not optional)', () => {
    const { providerId: _providerId, ...withoutProvider } = valid;
    expect(TrustSafetyBookingHoldRequestedSchema.safeParse(withoutProvider).success).toBe(false);
  });

  it('carries NO free text — description / notes are rejected', () => {
    expect(
      TrustSafetyBookingHoldRequestedSchema.safeParse({ ...valid, description: 'free text' })
        .success,
    ).toBe(false);
    expect(
      TrustSafetyBookingHoldRequestedSchema.safeParse({ ...valid, reason: 'she fell' }).success,
    ).toBe(false);
  });

  it('requires the envelope + a timestamped requestedAt', () => {
    const { eventId: _eventId, ...withoutEventId } = valid;
    expect(TrustSafetyBookingHoldRequestedSchema.safeParse(withoutEventId).success).toBe(false);
    expect(
      TrustSafetyBookingHoldRequestedSchema.safeParse({ ...valid, requestedAt: 'yesterday' })
        .success,
    ).toBe(false);
  });

  it('pins the severity + category vocabularies to the incident enums', () => {
    expect(
      TrustSafetyBookingHoldRequestedSchema.safeParse({ ...valid, severity: 'urgent' }).success,
    ).toBe(false);
    expect(
      TrustSafetyBookingHoldRequestedSchema.safeParse({ ...valid, category: 'abuse_neglect' })
        .success,
    ).toBe(false);
  });
});

describe('TrustSafetyBookingHoldReleased event', () => {
  const valid = {
    eventId: 'evt_release_1',
    occurredAt: '2026-07-27T12:00:00.000Z',
    incidentId: 'inc_1',
    severity: 'critical',
    category: 'safety',
    providerId: 'prv_1',
    seniorId: null,
    householdId: null,
    releasedAt: '2026-07-27T11:59:00.000Z',
  };

  it('accepts a valid release', () => {
    expect(TrustSafetyBookingHoldReleasedSchema.safeParse(valid).success).toBe(true);
  });

  it('REJECTS a subjectless release — the consumer needs them to re-evaluate', () => {
    expect(
      TrustSafetyBookingHoldReleasedSchema.safeParse({ ...valid, providerId: null }).success,
    ).toBe(false);
  });

  it('carries no free text and no requestedAt', () => {
    expect(
      TrustSafetyBookingHoldReleasedSchema.safeParse({
        ...valid,
        resolutionNotes: 'closed, unfounded',
      }).success,
    ).toBe(false);
    expect(
      TrustSafetyBookingHoldReleasedSchema.safeParse({
        ...valid,
        requestedAt: '2026-07-26T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
