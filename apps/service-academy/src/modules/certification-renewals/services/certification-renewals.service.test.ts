import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { CertificationRenewalsService } from './certification-renewals.service';
import { FakeCertificationRenewalsPrisma } from './__fixtures__/fake-prisma';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const DAY = 86_400_000;

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

interface SeedOverrides {
  id?: string;
  status?: string;
  expiresAt?: Date | null;
  title?: string;
  track?: string;
}

function seedCert(fake: FakeCertificationRenewalsPrisma, overrides: SeedOverrides = {}): void {
  fake.seed({
    id: overrides.id ?? 'cert_1',
    studentUserId: 'student_1',
    holderName: 'Jane Holder',
    courseId: 'course_1',
    title: overrides.title ?? 'Dementia-Sensitive Dining',
    track: overrides.track ?? 'dementia_sensitive',
    status: overrides.status ?? 'active',
    issuedAt: new Date('2024-06-08T12:00:00.000Z'),
    expiresAt: overrides.expiresAt === undefined ? daysFromNow(45) : overrides.expiresAt,
  });
}

function makeService(fake: FakeCertificationRenewalsPrisma): CertificationRenewalsService {
  return new CertificationRenewalsService(fake as unknown as PrismaService, () => NOW);
}

describe('CertificationRenewalsService.listRenewalCandidates', () => {
  it('returns active certifications within the horizon, projecting courseTitle', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_1', expiresAt: daysFromNow(45), title: 'Therapeutic Meals' });
    const service = makeService(fake);

    const result = await service.listRenewalCandidates({
      cursor: undefined,
      limit: 100,
      horizonDays: 90,
    });

    expect(result.certifications).toHaveLength(1);
    expect(result.certifications[0]).toMatchObject({
      certificationId: 'cert_1',
      courseTitle: 'Therapeutic Meals',
      expiresAt: daysFromNow(45).toISOString(),
    });
    expect(result.nextCursor).toBeNull();
  });

  it('includes already-lapsed certifications (expiry in the past)', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_lapsed', expiresAt: daysFromNow(-3) });
    const service = makeService(fake);

    const result = await service.listRenewalCandidates({
      cursor: undefined,
      limit: 100,
      horizonDays: 90,
    });

    expect(result.certifications.map((c) => c.certificationId)).toEqual(['cert_lapsed']);
  });

  it('excludes certifications expiring beyond the horizon', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_far', expiresAt: daysFromNow(120) });
    const service = makeService(fake);

    const result = await service.listRenewalCandidates({
      cursor: undefined,
      limit: 100,
      horizonDays: 90,
    });

    expect(result.certifications).toHaveLength(0);
  });

  it('excludes expired + revoked certifications', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_active', status: 'active', expiresAt: daysFromNow(30) });
    seedCert(fake, { id: 'cert_expired', status: 'expired', expiresAt: daysFromNow(30) });
    seedCert(fake, { id: 'cert_revoked', status: 'revoked', expiresAt: daysFromNow(30) });
    const service = makeService(fake);

    const result = await service.listRenewalCandidates({
      cursor: undefined,
      limit: 100,
      horizonDays: 90,
    });

    expect(result.certifications.map((c) => c.certificationId)).toEqual(['cert_active']);
  });

  it('keyset-paginates: returns nextCursor when a further page exists', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_a', expiresAt: daysFromNow(10) });
    seedCert(fake, { id: 'cert_b', expiresAt: daysFromNow(20) });
    seedCert(fake, { id: 'cert_c', expiresAt: daysFromNow(30) });
    const service = makeService(fake);

    const first = await service.listRenewalCandidates({
      cursor: undefined,
      limit: 2,
      horizonDays: 90,
    });
    expect(first.certifications.map((c) => c.certificationId)).toEqual(['cert_a', 'cert_b']);
    expect(first.nextCursor).toBe('cert_b');

    const second = await service.listRenewalCandidates({
      cursor: first.nextCursor ?? undefined,
      limit: 2,
      horizonDays: 90,
    });
    expect(second.certifications.map((c) => c.certificationId)).toEqual(['cert_c']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('CertificationRenewalsService.expireCertification', () => {
  it('flips an active, past-expiry certification to expired (changed=true)', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_1', status: 'active', expiresAt: daysFromNow(-1) });
    const service = makeService(fake);

    const result = await service.expireCertification('cert_1');

    expect(result).toEqual({ certificationId: 'cert_1', status: 'expired', changed: true });
  });

  it('is a no-op for an active certification not yet past expiry', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_1', status: 'active', expiresAt: daysFromNow(5) });
    const service = makeService(fake);

    const result = await service.expireCertification('cert_1');

    expect(result).toEqual({ certificationId: 'cert_1', status: 'active', changed: false });
  });

  it('is a no-op for an already-expired certification', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_1', status: 'expired', expiresAt: daysFromNow(-10) });
    const service = makeService(fake);

    const result = await service.expireCertification('cert_1');

    expect(result).toEqual({ certificationId: 'cert_1', status: 'expired', changed: false });
  });

  it('is a no-op for a revoked certification (terminal, never auto-expired)', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    seedCert(fake, { id: 'cert_1', status: 'revoked', expiresAt: daysFromNow(-10) });
    const service = makeService(fake);

    const result = await service.expireCertification('cert_1');

    expect(result).toEqual({ certificationId: 'cert_1', status: 'revoked', changed: false });
  });

  it('returns null when the certification does not exist', async () => {
    const fake = new FakeCertificationRenewalsPrisma();
    const service = makeService(fake);

    expect(await service.expireCertification('missing')).toBeNull();
  });
});
