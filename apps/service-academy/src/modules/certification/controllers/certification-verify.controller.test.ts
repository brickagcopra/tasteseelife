import { NotFoundException } from '@nestjs/common';
import type { PublicCertificationVerification } from '@taste-and-see/contracts';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { CertificationService } from '../services/certification.service';
import { CertificationVerifyController } from './certification-verify.controller';

/**
 * A tenant store whose `run` simply invokes the callback — verifies the
 * handler routes through `runWithoutTenantContext` (exempt frame) without a
 * real AsyncLocalStorage.
 */
const passthroughStore = {
  run: vi.fn((_frame: unknown, fn: () => unknown) => fn()),
} as unknown as TenantContextStore;

function build(service: Partial<CertificationService>): CertificationVerifyController {
  return new CertificationVerifyController(
    service as unknown as CertificationService,
    passthroughStore,
  );
}

const verification: PublicCertificationVerification = {
  holderName: 'Jane Holder',
  courseTitle: 'Dementia-Sensitive Dining',
  track: 'dementia_sensitive',
  status: 'active',
  valid: true,
  issuedAt: '2026-06-08T12:00:00.000Z',
  expiresAt: '2028-06-08T12:00:00.000Z',
};

describe('CertificationVerifyController.verify', () => {
  it('returns the public verification view through an exempt frame', async () => {
    const getVerificationByToken = vi.fn(async () => verification);
    const res = await build({ getVerificationByToken }).verify('tok_1');
    expect(res.verification.holderName).toBe('Jane Holder');
    expect(res.verification.valid).toBe(true);
    expect(getVerificationByToken).toHaveBeenCalledWith('tok_1');
    expect(passthroughStore.run).toHaveBeenCalled();
  });

  it('does not leak internal fields onto the wire (strict parse)', async () => {
    const getVerificationByToken = vi.fn(async () => verification);
    const res = await build({ getVerificationByToken }).verify('tok_1');
    expect(Object.keys(res.verification).sort()).toEqual(
      ['expiresAt', 'holderName', 'issuedAt', 'status', 'track', 'valid', 'courseTitle'].sort(),
    );
  });

  it('throws 404 when the token resolves to nothing', async () => {
    const getVerificationByToken = vi.fn(async () => null);
    await expect(build({ getVerificationByToken }).verify('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
