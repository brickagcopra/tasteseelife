import { describe, expect, it } from 'vitest';

import {
  PRIVACY_EXPORT_MAX_RECORDS_PER_SECTION,
  PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
  PrivacyExportSectionSchema,
  PrivacyExportServiceSlugSchema,
  PrivacyExportSliceParamsSchema,
  PrivacyExportSliceSchema,
  PrivacyExportWithholdingSchema,
} from '../http/privacy-export-slice.schema';

/**
 * Contract tests for the TS-309b export-contribution seam.
 *
 * The three properties under test are the ones every one of ~21 contributing
 * services will inherit, so they are worth pinning here rather than in each
 * service: "nothing" is two distinct outcomes, a withholding is declared, and
 * a truncated section cannot be expressed.
 */

const heldSlice = {
  schemaVersion: PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
  outcome: 'held' as const,
  service: 'service-identity',
  subjectKind: 'user' as const,
  subjectId: 'user_1',
  generatedAt: '2026-07-27T10:00:00.000Z',
  sections: [
    {
      key: 'account',
      label: 'Your account',
      recordCount: 1,
      records: [{ id: 'user_1', email: 'a@example.com' }],
    },
  ],
  withheld: [
    {
      key: 'password_hash',
      label: 'Your password',
      reason: 'credential_material' as const,
    },
  ],
};

describe('PrivacyExportSliceSchema', () => {
  it('accepts a held slice', () => {
    const parsed = PrivacyExportSliceSchema.parse(heldSlice);
    expect(parsed.outcome).toBe('held');
  });

  it('distinguishes "no records for this subject" from "never holds this kind"', () => {
    const base = {
      schemaVersion: PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
      service: 'service-identity',
      subjectKind: 'senior' as const,
      subjectId: 'senior_1',
      generatedAt: '2026-07-27T10:00:00.000Z',
    };

    expect(PrivacyExportSliceSchema.parse({ ...base, outcome: 'no_records' }).outcome).toBe(
      'no_records',
    );
    expect(PrivacyExportSliceSchema.parse({ ...base, outcome: 'not_applicable' }).outcome).toBe(
      'not_applicable',
    );
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      PrivacyExportSliceSchema.parse({ ...heldSlice, outcome: 'partial' }),
    ).toThrowError();
  });

  it('rejects a held slice with no sections — "held" must hold something', () => {
    expect(() => PrivacyExportSliceSchema.parse({ ...heldSlice, sections: [] })).toThrowError();
  });

  it('requires withheld to be present on a held slice', () => {
    const { withheld: _withheld, ...withoutWithheld } = heldSlice;
    expect(() => PrivacyExportSliceSchema.parse(withoutWithheld)).toThrowError();
  });

  it('rejects sections on a no_records slice — strict, so drift is an error', () => {
    expect(() =>
      PrivacyExportSliceSchema.parse({
        schemaVersion: PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
        outcome: 'no_records',
        service: 'service-identity',
        subjectKind: 'user',
        subjectId: 'user_1',
        generatedAt: '2026-07-27T10:00:00.000Z',
        sections: [],
      }),
    ).toThrowError();
  });

  it('pins the schema version — an artefact must name its own shape', () => {
    expect(() => PrivacyExportSliceSchema.parse({ ...heldSlice, schemaVersion: 2 })).toThrowError();
  });

  it('requires an offset-bearing timestamp', () => {
    expect(() =>
      PrivacyExportSliceSchema.parse({ ...heldSlice, generatedAt: '2026-07-27 10:00:00' }),
    ).toThrowError();
  });
});

describe('PrivacyExportSectionSchema', () => {
  it('rejects a section whose recordCount disagrees with its records', () => {
    const result = PrivacyExportSectionSchema.safeParse({
      key: 'messages',
      label: 'Your messages',
      recordCount: 12_0,
      records: [{ id: 'm1' }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['recordCount']);
    }
  });

  it('accepts an empty section', () => {
    expect(
      PrivacyExportSectionSchema.parse({
        key: 'bookings',
        label: 'Your visits',
        recordCount: 0,
        records: [],
      }).recordCount,
    ).toBe(0);
  });

  it('rejects more records than one response may carry', () => {
    const records = Array.from({ length: PRIVACY_EXPORT_MAX_RECORDS_PER_SECTION + 1 }, (_, i) => ({
      id: String(i),
    }));

    expect(() =>
      PrivacyExportSectionSchema.parse({
        key: 'bookings',
        label: 'Your visits',
        recordCount: records.length,
        records,
      }),
    ).toThrowError();
  });

  it('rejects a non-identifier key', () => {
    expect(() =>
      PrivacyExportSectionSchema.parse({
        key: 'Sign In Sessions',
        label: 'Your sign-ins',
        recordCount: 0,
        records: [],
      }),
    ).toThrowError();
  });

  it('rejects a record that is not an object', () => {
    expect(() =>
      PrivacyExportSectionSchema.parse({
        key: 'notes',
        label: 'Your notes',
        recordCount: 1,
        records: ['a note'],
      }),
    ).toThrowError();
  });
});

describe('PrivacyExportWithholdingSchema', () => {
  it('accepts each categorical reason', () => {
    for (const reason of [
      'credential_material',
      'identity_evidence',
      'security_control',
      'third_party_data',
    ] as const) {
      expect(
        PrivacyExportWithholdingSchema.parse({ key: 'k', label: 'Something', reason }).reason,
      ).toBe(reason);
    }
  });

  it('rejects a free-text reason', () => {
    expect(() =>
      PrivacyExportWithholdingSchema.parse({
        key: 'k',
        label: 'Something',
        reason: 'we would rather not',
      }),
    ).toThrowError();
  });
});

describe('PrivacyExportServiceSlugSchema', () => {
  it.each(['service-identity', 'service-booking', 'api-gateway'])('accepts %s', (slug) => {
    expect(PrivacyExportServiceSlugSchema.parse(slug)).toBe(slug);
  });

  it.each(['Service-Identity', '-identity', 'service_identity', ''])('rejects %s', (slug) => {
    expect(() => PrivacyExportServiceSlugSchema.parse(slug)).toThrowError();
  });
});

describe('PrivacyExportSliceParamsSchema', () => {
  it('accepts each subject kind', () => {
    for (const subjectKind of ['user', 'senior', 'provider'] as const) {
      expect(
        PrivacyExportSliceParamsSchema.parse({ subjectKind, subjectId: 'abc' }).subjectKind,
      ).toBe(subjectKind);
    }
  });

  it('rejects an unknown subject kind', () => {
    expect(() =>
      PrivacyExportSliceParamsSchema.parse({ subjectKind: 'household', subjectId: 'abc' }),
    ).toThrowError();
  });

  it('rejects an empty subject id', () => {
    expect(() =>
      PrivacyExportSliceParamsSchema.parse({ subjectKind: 'user', subjectId: '   ' }),
    ).toThrowError();
  });
});
