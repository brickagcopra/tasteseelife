import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AcademyCertificationRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  CertificationService,
  IssueCertificationOutcome,
  RevokeCertificationOutcome,
} from '../services/certification.service';
import { CertificationAdminController } from './certification-admin.controller';

const TS = '2026-06-08T12:00:00.000Z';

function record(overrides: Partial<AcademyCertificationRecord> = {}): AcademyCertificationRecord {
  return {
    id: 'cert_1',
    studentUserId: 'student_1',
    courseId: 'course_1',
    enrollmentId: null,
    title: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    holderName: 'Jane Holder',
    status: 'active',
    verificationToken: 'tok_1',
    certificatePdfKey: 'test/academy_certificate/2026/06/cert_1.pdf',
    issuedAt: TS,
    expiresAt: '2028-06-08T12:00:00.000Z',
    revokedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function build(service: Partial<CertificationService>): CertificationAdminController {
  return new CertificationAdminController(service as unknown as CertificationService);
}

describe('CertificationAdminController.issue', () => {
  it('returns the issued certification', async () => {
    const issueCertification = vi.fn(
      async (): Promise<IssueCertificationOutcome> => ({
        ok: true,
        created: true,
        certification: record(),
      }),
    );
    const res = await build({ issueCertification }).issue({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane Holder',
    });
    expect(res.certification.id).toBe('cert_1');
  });

  it('maps course_not_found → 404', async () => {
    const issueCertification = vi.fn(
      async (): Promise<IssueCertificationOutcome> => ({ ok: false, reason: 'course_not_found' }),
    );
    await expect(
      build({ issueCertification }).issue({ studentUserId: 's', courseId: 'c', holderName: 'J' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps enrollment_not_found → 404', async () => {
    const issueCertification = vi.fn(
      async (): Promise<IssueCertificationOutcome> => ({
        ok: false,
        reason: 'enrollment_not_found',
      }),
    );
    await expect(
      build({ issueCertification }).issue({
        studentUserId: 's',
        courseId: 'c',
        enrollmentId: 'e',
        holderName: 'J',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps enrollment_not_completed → 422', async () => {
    const issueCertification = vi.fn(
      async (): Promise<IssueCertificationOutcome> => ({
        ok: false,
        reason: 'enrollment_not_completed',
      }),
    );
    await expect(
      build({ issueCertification }).issue({
        studentUserId: 's',
        courseId: 'c',
        enrollmentId: 'e',
        holderName: 'J',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('CertificationAdminController.list / detail', () => {
  it('lists certifications', async () => {
    const listCertifications = vi.fn(async () => [record(), record({ id: 'cert_2' })]);
    const res = await build({ listCertifications }).list({ limit: 50 });
    expect(res.certifications).toHaveLength(2);
  });

  it('returns a single certification, 404 when missing', async () => {
    const getCertification = vi.fn(async (id: string) => (id === 'cert_1' ? record() : null));
    expect((await build({ getCertification }).detail('cert_1')).certification.id).toBe('cert_1');
    await expect(build({ getCertification }).detail('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CertificationAdminController.revoke', () => {
  it('revokes a certification', async () => {
    const revokeCertification = vi.fn(
      async (): Promise<RevokeCertificationOutcome> => ({
        ok: true,
        certification: record({ status: 'revoked', revokedAt: TS }),
      }),
    );
    const res = await build({ revokeCertification }).revoke('cert_1', { reason: 'fraud' });
    expect(res.certification.status).toBe('revoked');
  });

  it('maps not_found → 404 and already_revoked → 409', async () => {
    const notFound = vi.fn(
      async (): Promise<RevokeCertificationOutcome> => ({ ok: false, reason: 'not_found' }),
    );
    await expect(build({ revokeCertification: notFound }).revoke('x', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const already = vi.fn(
      async (): Promise<RevokeCertificationOutcome> => ({ ok: false, reason: 'already_revoked' }),
    );
    await expect(
      build({ revokeCertification: already }).revoke('cert_1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
