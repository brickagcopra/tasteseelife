import 'reflect-metadata';

import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  InternalCertificationRenewalsQuerySchema,
  type CertificationRenewalCandidate,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { CertificationRenewalsService } from '../services/certification-renewals.service';

import { CertificationRenewalsInternalController } from './certification-renewals-internal.controller';

const SECRET = 'r'.repeat(48);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
    ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_HEADER_NAME: HEADER,
    ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_API_KEY: SECRET,
  } as unknown as Env;
}

function fakeRequest(headerValue?: string): Request {
  return {
    header: (name: string): string | undefined => (name === HEADER ? headerValue : undefined),
  } as unknown as Request;
}

const CANDIDATE: CertificationRenewalCandidate = {
  certificationId: 'cert_1',
  studentUserId: 'student_1',
  holderName: 'Jane Holder',
  courseId: 'course_1',
  courseTitle: 'Dementia-Sensitive Dining',
  track: 'dementia_sensitive',
  issuedAt: '2024-06-08T12:00:00.000Z',
  expiresAt: '2026-07-23T12:00:00.000Z',
};

function buildController(
  serviceOverrides: Partial<{
    listRenewalCandidates: ReturnType<typeof vi.fn>;
    expireCertification: ReturnType<typeof vi.fn>;
  }> = {},
): {
  controller: CertificationRenewalsInternalController;
  service: {
    listRenewalCandidates: ReturnType<typeof vi.fn>;
    expireCertification: ReturnType<typeof vi.fn>;
  };
  store: TenantContextStore;
} {
  const service = {
    listRenewalCandidates:
      serviceOverrides.listRenewalCandidates ??
      vi.fn(async () => ({ certifications: [CANDIDATE], nextCursor: null })),
    expireCertification:
      serviceOverrides.expireCertification ??
      vi.fn(async () => ({ certificationId: 'cert_1', status: 'expired', changed: true })),
  };
  const store = new TenantContextStore();
  const controller = new CertificationRenewalsInternalController(
    service as unknown as CertificationRenewalsService,
    makeEnv(),
    store,
  );
  return { controller, service, store };
}

describe('CertificationRenewalsInternalController.listRenewals — shared secret', () => {
  const query = { cursor: undefined, limit: 100, horizonDays: 90 };

  it('rejects a missing shared-secret header with 401', async () => {
    const { controller, service } = buildController();
    await expect(controller.listRenewals(query, fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.listRenewalCandidates).not.toHaveBeenCalled();
  });

  it('rejects a same-length-but-different-bytes header with 401', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.listRenewals(query, fakeRequest('q'.repeat(SECRET.length))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.listRenewalCandidates).not.toHaveBeenCalled();
  });

  it('returns the parsed response and forwards the query when the secret matches', async () => {
    const { controller, service } = buildController();
    const response = await controller.listRenewals(query, fakeRequest(SECRET));
    expect(service.listRenewalCandidates).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 100,
      horizonDays: 90,
    });
    expect(response).toEqual({ certifications: [CANDIDATE], nextCursor: null });
  });

  it('rejects (does not pass) a service projection carrying an extra field', async () => {
    const { controller } = buildController({
      listRenewalCandidates: vi.fn(async () => ({
        certifications: [{ ...CANDIDATE, verificationToken: 'leak' }],
        nextCursor: null,
      })),
    });
    await expect(
      controller.listRenewals(
        { cursor: undefined, limit: 100, horizonDays: 90 },
        fakeRequest(SECRET),
      ),
    ).rejects.toThrow();
  });
});

describe('CertificationRenewalsInternalController.expireCertification — shared secret', () => {
  it('rejects a missing shared-secret header with 401', async () => {
    const { controller, service } = buildController();
    await expect(controller.expireCertification('cert_1', fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.expireCertification).not.toHaveBeenCalled();
  });

  it('returns the parsed response when the secret matches', async () => {
    const { controller, service } = buildController();
    const response = await controller.expireCertification('cert_1', fakeRequest(SECRET));
    expect(service.expireCertification).toHaveBeenCalledWith('cert_1');
    expect(response).toEqual({ certificationId: 'cert_1', status: 'expired', changed: true });
  });

  it('maps a missing certification (service null) to 404', async () => {
    const { controller } = buildController({ expireCertification: vi.fn(async () => null) });
    await expect(
      controller.expireCertification('missing', fakeRequest(SECRET)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes through an idempotent no-op response', async () => {
    const { controller } = buildController({
      expireCertification: vi.fn(async () => ({
        certificationId: 'cert_1',
        status: 'expired',
        changed: false,
      })),
    });
    const response = await controller.expireCertification('cert_1', fakeRequest(SECRET));
    expect(response).toMatchObject({ changed: false });
  });
});

describe('CertificationRenewalsInternalController query validation (ZodValidationPipe)', () => {
  const pipe = new ZodValidationPipe(InternalCertificationRenewalsQuerySchema);

  it('accepts an empty query and applies defaults', () => {
    expect(pipe.transform({})).toEqual({ limit: 100, horizonDays: 90 });
  });

  it('rejects a limit over the cap with 400', () => {
    expect(() => pipe.transform({ limit: '501' })).toThrow(BadRequestException);
  });

  it('rejects unknown query fields (strict) with 400', () => {
    expect(() => pipe.transform({ status: 'active' })).toThrow(BadRequestException);
  });
});

describe('CertificationRenewalsInternalController tenant-scope exempt wrap (TS-256)', () => {
  it('runs listRenewals inside an exempt frame with the renewals reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const service = {
      listRenewalCandidates: vi.fn(async () => {
        captured = store.current();
        return { certifications: [CANDIDATE], nextCursor: null };
      }),
      expireCertification: vi.fn(),
    };
    const controller = new CertificationRenewalsInternalController(
      service as unknown as CertificationRenewalsService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.listRenewals(
      { cursor: undefined, limit: 100, horizonDays: 90 },
      fakeRequest(SECRET),
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'academy-internal-certification-renewals' });
  });

  it('runs the expire 401 branch inside the expire exempt frame', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const request = {
      header: (name: string): string | undefined => {
        if (name === HEADER) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as Request;
    const service = { listRenewalCandidates: vi.fn(), expireCertification: vi.fn() };
    const controller = new CertificationRenewalsInternalController(
      service as unknown as CertificationRenewalsService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await expect(controller.expireCertification('cert_1', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'academy-internal-certification-expire' });
    expect(service.expireCertification).not.toHaveBeenCalled();
  });
});
