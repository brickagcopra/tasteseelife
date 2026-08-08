import { describe, expect, it } from 'vitest';

import {
  CreateKycSessionResponseSchema,
  KycInternalWebhookEventSchema,
  KycInternalWebhookResponseSchema,
  KycRecordSchema,
  KycStatusResponseSchema,
  type CreateKycSessionResponse,
  type KycInternalWebhookEvent,
  type KycRecord,
  type KycStatusResponse,
} from '../http/kyc.schema';

const validRecord: KycRecord = {
  id: 'kyc_1',
  provider: 'stripe_identity',
  status: 'requires_input',
  externalId: 'vs_abc',
  verifiedAt: null,
  createdAt: '2026-05-11T12:00:00.000Z',
  updatedAt: '2026-05-11T12:00:00.000Z',
};

describe('KycRecordSchema', () => {
  it('accepts a valid record and round-trips it unchanged', () => {
    const parsed = KycRecordSchema.parse(validRecord);
    expect(parsed).toEqual(validRecord);
  });

  it('accepts a verifiedAt timestamp when status is verified', () => {
    const verified: KycRecord = {
      ...validRecord,
      status: 'verified',
      verifiedAt: '2026-05-11T12:30:00.000Z',
    };
    expect(KycRecordSchema.parse(verified)).toEqual(verified);
  });

  it('rejects unknown top-level fields (`.strict()`)', () => {
    const result = KycRecordSchema.safeParse({ ...validRecord, secret: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown provider value', () => {
    const result = KycRecordSchema.safeParse({ ...validRecord, provider: 'checkr' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status value', () => {
    const result = KycRecordSchema.safeParse({ ...validRecord, status: 'rejected' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO verifiedAt', () => {
    const result = KycRecordSchema.safeParse({
      ...validRecord,
      verifiedAt: '2026/05/11 12:00:00',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateKycSessionResponseSchema', () => {
  const validResponse: CreateKycSessionResponse = {
    record: validRecord,
    clientSecret: 'cs_abc',
    hostedUrl: 'https://verify.stripe.com/v1/abc',
  };

  it('accepts a fully-populated response', () => {
    expect(CreateKycSessionResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('accepts null clientSecret / hostedUrl (terminal states)', () => {
    const terminal: CreateKycSessionResponse = {
      record: { ...validRecord, status: 'verified' },
      clientSecret: null,
      hostedUrl: null,
    };
    expect(CreateKycSessionResponseSchema.parse(terminal)).toEqual(terminal);
  });

  it('rejects a non-URL hostedUrl', () => {
    expect(
      CreateKycSessionResponseSchema.safeParse({
        ...validResponse,
        hostedUrl: 'not-a-url',
      }).success,
    ).toBe(false);
  });
});

describe('KycStatusResponseSchema', () => {
  it('accepts a populated record', () => {
    const r: KycStatusResponse = { record: validRecord };
    expect(KycStatusResponseSchema.parse(r)).toEqual(r);
  });

  it('accepts a null record (no KYC session yet)', () => {
    expect(KycStatusResponseSchema.parse({ record: null })).toEqual({ record: null });
  });

  it('rejects unknown top-level fields', () => {
    expect(KycStatusResponseSchema.safeParse({ record: validRecord, extra: 'x' }).success).toBe(
      false,
    );
  });
});

describe('KycInternalWebhookEventSchema', () => {
  const validEvent: KycInternalWebhookEvent = {
    eventId: 'evt_abc',
    eventType: 'identity.verification_session.verified',
    eventCreatedSeconds: 1_700_000_000,
    session: {
      id: 'vs_abc',
      status: 'verified',
      clientSecret: null,
      hostedUrl: null,
      verifiedAtSeconds: 1_700_000_000,
    },
    rawPayload: JSON.stringify({ id: 'vs_abc', object: 'identity.verification_session' }),
  };

  it('accepts a well-formed dispatch payload', () => {
    expect(KycInternalWebhookEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('rejects an unbounded rawPayload', () => {
    const oversized = { ...validEvent, rawPayload: 'x'.repeat(65_537) };
    expect(KycInternalWebhookEventSchema.safeParse(oversized).success).toBe(false);
  });

  it('rejects unknown top-level fields (locked-down boundary)', () => {
    expect(KycInternalWebhookEventSchema.safeParse({ ...validEvent, extra: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects unknown session.status values', () => {
    expect(
      KycInternalWebhookEventSchema.safeParse({
        ...validEvent,
        session: { ...validEvent.session, status: 'unknown' },
      }).success,
    ).toBe(false);
  });

  it('rejects a negative eventCreatedSeconds', () => {
    expect(
      KycInternalWebhookEventSchema.safeParse({ ...validEvent, eventCreatedSeconds: -1 }).success,
    ).toBe(false);
  });
});

describe('KycInternalWebhookResponseSchema', () => {
  it('accepts an `applied` outcome with a record', () => {
    expect(
      KycInternalWebhookResponseSchema.parse({
        outcome: 'applied',
        record: validRecord,
      }),
    ).toEqual({ outcome: 'applied', record: validRecord });
  });

  it('accepts a `session_mismatch` outcome with null record', () => {
    expect(
      KycInternalWebhookResponseSchema.parse({
        outcome: 'session_mismatch',
        record: null,
      }),
    ).toEqual({ outcome: 'session_mismatch', record: null });
  });

  it('rejects unknown outcome strings', () => {
    expect(
      KycInternalWebhookResponseSchema.safeParse({ outcome: 'maybe', record: null }).success,
    ).toBe(false);
  });
});
