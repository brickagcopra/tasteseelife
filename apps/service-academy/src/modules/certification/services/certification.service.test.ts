import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import { CertificatePdfStore } from './certificate-pdf-store';
import { CertificationService, addUtcMonths, toCertificationRecord } from './certification.service';
import { FakeAcademyCertificationPrisma } from './__fixtures__/fake-prisma';

const NOW = new Date('2026-06-08T12:00:00.000Z');

function buildEnv(): Env {
  return { NODE_ENV: 'test', ACADEMY_PUBLIC_BASE_URL: 'https://app.example.com' } as Env;
}

function buildService(fake: FakeAcademyCertificationPrisma): {
  service: CertificationService;
  renderPdf: ReturnType<typeof vi.fn>;
  store: CertificatePdfStore;
} {
  const env = buildEnv();
  const store = new CertificatePdfStore(env);
  // A renderer stub so the unit test never invokes pdfkit (covered separately).
  const renderPdf = vi.fn(async () => Buffer.from('%PDF-stub'));
  let tokenCounter = 0;
  const tokenFactory = (): string => `tok_${(tokenCounter += 1)}`;
  const service = new CertificationService(
    fake as unknown as PrismaService,
    store,
    env,
    () => NOW,
    tokenFactory,
    renderPdf,
  );
  return { service, renderPdf, store };
}

function seedCourse(
  fake: FakeAcademyCertificationPrisma,
  overrides: Record<string, unknown> = {},
): void {
  fake.academyCourse.seed({
    id: 'course_1',
    title: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    deletedAt: null,
    ...overrides,
  } as never);
}

describe('addUtcMonths', () => {
  it('adds calendar months in UTC', () => {
    expect(addUtcMonths(new Date('2026-06-08T12:00:00.000Z'), 24).toISOString()).toBe(
      '2028-06-08T12:00:00.000Z',
    );
  });
});

describe('CertificationService.issueCertification', () => {
  it('issues a certification, renders + stores the PDF, and stamps the key', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service, renderPdf, store } = buildService(fake);
    const storeSpy = vi.spyOn(store, 'store');

    const outcome = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane Holder',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.created).toBe(true);
    expect(outcome.certification.title).toBe('Dementia-Sensitive Dining');
    expect(outcome.certification.track).toBe('dementia_sensitive');
    expect(outcome.certification.holderName).toBe('Jane Holder');
    expect(outcome.certification.status).toBe('active');
    expect(outcome.certification.verificationToken).toBe('tok_1');
    // Default 24-month expiry from the injected clock.
    expect(outcome.certification.expiresAt).toBe('2028-06-08T12:00:00.000Z');
    // PDF rendered with the absolute verification URL + stored under the key.
    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(renderPdf.mock.calls[0]?.[0].verificationUrl).toBe(
      'https://app.example.com/verify/cert/tok_1',
    );
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(outcome.certification.certificatePdfKey).toBe(
      'test/academy_certificate/2026/06/cert_1.pdf',
    );
  });

  it('honours an explicit expiresInMonths', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service } = buildService(fake);
    const outcome = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane',
      expiresInMonths: 12,
    });
    expect(outcome.ok && outcome.certification.expiresAt).toBe('2027-06-08T12:00:00.000Z');
  });

  it('is idempotent on (student, course): a second issue returns the existing active cert, no new render', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service, renderPdf } = buildService(fake);

    const first = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane',
    });
    const second = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane',
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.created).toBe(false);
    expect(second.certification.id).toBe(first.certification.id);
    expect(renderPdf).toHaveBeenCalledTimes(1); // not re-rendered
    expect(fake.academyCertification.rows).toHaveLength(1);
  });

  it('rejects when the course is missing or soft-deleted', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    const { service } = buildService(fake);
    const missing = await service.issueCertification({
      studentUserId: 's',
      courseId: 'nope',
      holderName: 'J',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('course_not_found');

    seedCourse(fake, { id: 'course_del', deletedAt: NOW });
    const deleted = await service.issueCertification({
      studentUserId: 's',
      courseId: 'course_del',
      holderName: 'J',
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toBe('course_not_found');
  });

  it('validates the enrollment when enrollmentId is supplied', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service } = buildService(fake);

    // Missing enrollment.
    const missing = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: 'enr_x',
      holderName: 'J',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('enrollment_not_found');

    // Enrollment for a different student → not_found (ownership mismatch).
    fake.academyEnrollment.seed({
      id: 'enr_other',
      studentUserId: 'other',
      courseId: 'course_1',
      status: 'completed',
      deletedAt: null,
    } as never);
    const mismatch = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: 'enr_other',
      holderName: 'J',
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe('enrollment_not_found');

    // Enrollment present + owned but not completed → not_completed.
    fake.academyEnrollment.seed({
      id: 'enr_active',
      studentUserId: 'student_1',
      courseId: 'course_1',
      status: 'active',
      deletedAt: null,
    } as never);
    const notDone = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: 'enr_active',
      holderName: 'J',
    });
    expect(notDone.ok).toBe(false);
    if (!notDone.ok) expect(notDone.reason).toBe('enrollment_not_completed');
  });

  it('issues when a supplied enrollment is completed + owned', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    fake.academyEnrollment.seed({
      id: 'enr_done',
      studentUserId: 'student_1',
      courseId: 'course_1',
      status: 'completed',
      deletedAt: null,
    } as never);
    const { service } = buildService(fake);
    const outcome = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: 'enr_done',
      holderName: 'Jane',
    });
    expect(outcome.ok && outcome.certification.enrollmentId).toBe('enr_done');
  });
});

describe('CertificationService reads + revoke', () => {
  async function seedOneCert(): Promise<{
    fake: FakeAcademyCertificationPrisma;
    service: CertificationService;
    id: string;
    token: string;
  }> {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service } = buildService(fake);
    const outcome = await service.issueCertification({
      studentUserId: 'student_1',
      courseId: 'course_1',
      holderName: 'Jane',
    });
    if (!outcome.ok) throw new Error('seed issue failed');
    return {
      fake,
      service,
      id: outcome.certification.id,
      token: outcome.certification.verificationToken,
    };
  }

  it('lists with filters and reads one', async () => {
    const { service, id } = await seedOneCert();
    const all = await service.listCertifications({ limit: 50 });
    expect(all).toHaveLength(1);
    const filtered = await service.listCertifications({ studentUserId: 'student_1', limit: 50 });
    expect(filtered).toHaveLength(1);
    const none = await service.listCertifications({ studentUserId: 'nobody', limit: 50 });
    expect(none).toHaveLength(0);
    expect((await service.getCertification(id))?.id).toBe(id);
    expect(await service.getCertification('missing')).toBeNull();
  });

  it('revokes once, then reports already_revoked / not_found', async () => {
    const { service, id } = await seedOneCert();
    const revoked = await service.revokeCertification(id, 'fraud');
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.certification.status).toBe('revoked');
      expect(revoked.certification.revokedAt).toBe(NOW.toISOString());
    }
    const again = await service.revokeCertification(id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already_revoked');
    const missing = await service.revokeCertification('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not_found');
  });

  it('verifies by token: active → valid; revoked → not valid; unknown → null', async () => {
    const { service, token, id } = await seedOneCert();
    const active = await service.getVerificationByToken(token);
    expect(active).not.toBeNull();
    expect(active?.valid).toBe(true);
    expect(active?.holderName).toBe('Jane');
    expect(active?.courseTitle).toBe('Dementia-Sensitive Dining');

    await service.revokeCertification(id);
    const afterRevoke = await service.getVerificationByToken(token);
    expect(afterRevoke?.status).toBe('revoked');
    expect(afterRevoke?.valid).toBe(false);

    expect(await service.getVerificationByToken('unknown')).toBeNull();
  });

  it('marks an active-but-expired certification as not valid', async () => {
    const fake = new FakeAcademyCertificationPrisma();
    seedCourse(fake);
    const { service } = buildService(fake);
    // Seed an active cert that already expired (past `expiresAt`, status still active).
    fake.academyCertification.seed({
      id: 'cert_exp',
      studentUserId: 'student_1',
      courseId: 'course_1',
      enrollmentId: null,
      title: 'X',
      track: 'general',
      holderName: 'Jane',
      status: 'active',
      verificationToken: 'tok_expired',
      certificatePdfKey: null,
      issuedAt: new Date('2024-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
      revokedAt: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    } as never);
    const v = await service.getVerificationByToken('tok_expired');
    expect(v?.status).toBe('active');
    expect(v?.valid).toBe(false); // past expiry
  });
});

describe('toCertificationRecord', () => {
  it('projects nullable timestamps + keys', () => {
    const record = toCertificationRecord({
      id: 'cert_1',
      studentUserId: 's',
      courseId: 'c',
      enrollmentId: null,
      title: 'T',
      track: 'general',
      holderName: null,
      status: 'active',
      verificationToken: 'tok',
      certificatePdfKey: null,
      issuedAt: NOW,
      expiresAt: null,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(record.expiresAt).toBeNull();
    expect(record.revokedAt).toBeNull();
    expect(record.certificatePdfKey).toBeNull();
    expect(record.issuedAt).toBe(NOW.toISOString());
  });
});
