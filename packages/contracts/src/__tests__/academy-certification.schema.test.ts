import { describe, expect, it } from 'vitest';

import {
  ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH,
  AcademyCertificationRecordSchema,
  AcademyCertificationResponseSchema,
  AcademyCertificationStatusSchema,
  AcademyCertificationsListResponseSchema,
  IssueAcademyCertificationRequestSchema,
  ListAcademyCertificationsQuerySchema,
  PublicCertificationVerificationSchema,
  RevokeAcademyCertificationRequestSchema,
} from '../http/academy-certification.schema';

const TS = '2026-06-08T12:00:00.000Z';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cert_1',
    studentUserId: 'student_1',
    courseId: 'course_1',
    enrollmentId: 'enr_1',
    title: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    holderName: 'Jane Holder',
    status: 'active',
    verificationToken: 'tok_abc123',
    certificatePdfKey: 'dev/academy_certificate/2026/06/cert_1.pdf',
    issuedAt: TS,
    expiresAt: TS,
    revokedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

describe('AcademyCertificationStatusSchema', () => {
  it('accepts the three statuses and rejects others', () => {
    expect(AcademyCertificationStatusSchema.parse('active')).toBe('active');
    expect(AcademyCertificationStatusSchema.parse('expired')).toBe('expired');
    expect(AcademyCertificationStatusSchema.parse('revoked')).toBe('revoked');
    expect(AcademyCertificationStatusSchema.safeParse('suspended').success).toBe(false);
  });
});

describe('IssueAcademyCertificationRequestSchema', () => {
  it('parses a minimal issue request (no enrollmentId / expiresInMonths)', () => {
    const parsed = IssueAcademyCertificationRequestSchema.parse({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane Holder',
    });
    expect(parsed.enrollmentId).toBeUndefined();
    expect(parsed.expiresInMonths).toBeUndefined();
  });

  it('parses a full issue request', () => {
    const parsed = IssueAcademyCertificationRequestSchema.parse({
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: 'enr_1',
      holderName: 'Jane Holder',
      expiresInMonths: 24,
    });
    expect(parsed.expiresInMonths).toBe(24);
  });

  it('rejects an empty holderName and one over the cap', () => {
    expect(
      IssueAcademyCertificationRequestSchema.safeParse({
        studentUserId: 'student_1',
        courseId: 'course_1',
        holderName: '',
      }).success,
    ).toBe(false);
    expect(
      IssueAcademyCertificationRequestSchema.safeParse({
        studentUserId: 'student_1',
        courseId: 'course_1',
        holderName: 'x'.repeat(ACADEMY_CERTIFICATION_HOLDER_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects expiresInMonths below 1 or above the cap', () => {
    expect(
      IssueAcademyCertificationRequestSchema.safeParse({
        studentUserId: 'student_1',
        courseId: 'course_1',
        holderName: 'Jane',
        expiresInMonths: 0,
      }).success,
    ).toBe(false);
    expect(
      IssueAcademyCertificationRequestSchema.safeParse({
        studentUserId: 'student_1',
        courseId: 'course_1',
        holderName: 'Jane',
        expiresInMonths: 121,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      IssueAcademyCertificationRequestSchema.safeParse({
        studentUserId: 'student_1',
        courseId: 'course_1',
        holderName: 'Jane',
        track: 'general',
      }).success,
    ).toBe(false);
  });
});

describe('RevokeAcademyCertificationRequestSchema', () => {
  it('parses an empty body and an optional reason', () => {
    expect(RevokeAcademyCertificationRequestSchema.parse({})).toEqual({});
    expect(RevokeAcademyCertificationRequestSchema.parse({ reason: 'fraud' }).reason).toBe('fraud');
  });

  it('rejects an empty-string reason', () => {
    expect(RevokeAcademyCertificationRequestSchema.safeParse({ reason: '' }).success).toBe(false);
  });
});

describe('ListAcademyCertificationsQuerySchema', () => {
  it('defaults the limit and coerces the string', () => {
    expect(ListAcademyCertificationsQuerySchema.parse({}).limit).toBe(50);
    expect(ListAcademyCertificationsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects an out-of-range status filter', () => {
    expect(ListAcademyCertificationsQuerySchema.safeParse({ status: 'pending' }).success).toBe(
      false,
    );
  });
});

describe('AcademyCertificationRecordSchema', () => {
  it('parses a full record and a revoked record with null pdf key', () => {
    expect(AcademyCertificationRecordSchema.parse(record()).status).toBe('active');
    const revoked = AcademyCertificationRecordSchema.parse(
      record({ status: 'revoked', revokedAt: TS, certificatePdfKey: null, enrollmentId: null }),
    );
    expect(revoked.certificatePdfKey).toBeNull();
    expect(revoked.enrollmentId).toBeNull();
  });

  it('round-trips through the single + list envelopes', () => {
    expect(
      AcademyCertificationResponseSchema.parse({ certification: record() }).certification.id,
    ).toBe('cert_1');
    expect(
      AcademyCertificationsListResponseSchema.parse({ certifications: [record()] }).certifications,
    ).toHaveLength(1);
  });
});

describe('PublicCertificationVerificationSchema', () => {
  it('parses the PII-minimised public view', () => {
    const parsed = PublicCertificationVerificationSchema.parse({
      holderName: 'Jane Holder',
      courseTitle: 'Dementia-Sensitive Dining',
      track: 'dementia_sensitive',
      status: 'active',
      valid: true,
      issuedAt: TS,
      expiresAt: TS,
    });
    expect(parsed.valid).toBe(true);
  });

  it('REJECTS leaking the studentUserId, pdf key, or internal id (strict subset)', () => {
    for (const leak of [
      { studentUserId: 'student_1' },
      { certificatePdfKey: 'k' },
      { id: 'cert_1' },
      { enrollmentId: 'enr_1' },
      { verificationToken: 'tok' },
    ]) {
      expect(
        PublicCertificationVerificationSchema.safeParse({
          holderName: 'Jane',
          courseTitle: 'C',
          track: 'general',
          status: 'active',
          valid: true,
          issuedAt: TS,
          expiresAt: null,
          ...leak,
        }).success,
      ).toBe(false);
    }
  });
});
