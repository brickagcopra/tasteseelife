import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type { JurisdictionRow } from '../repositories/mandated-reporter.repository';
import { MandatedReporterService } from '../services/mandated-reporter.service';
import { MandatedReporterJurisdictionsController } from './jurisdictions.controller';

function buildRow(overrides: Partial<JurisdictionRow> = {}): JurisdictionRow {
  return {
    stateCode: 'NY',
    agencyName: null,
    reportingPhone: null,
    reportingUrl: null,
    statutoryDeadlineHours: null,
    platformRole: 'undetermined',
    statuteCitation: null,
    verified: false,
    verifiedAt: null,
    verifiedByUserId: null,
    notes: null,
    ...overrides,
  };
}

interface FakeService {
  listJurisdictions: ReturnType<typeof vi.fn>;
  getJurisdiction: ReturnType<typeof vi.fn>;
  upsertJurisdiction: ReturnType<typeof vi.fn>;
  setJurisdictionVerification: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: MandatedReporterJurisdictionsController;
  service: FakeService;
} {
  const service: FakeService = {
    listJurisdictions: vi.fn(async (): Promise<JurisdictionRow[]> => [buildRow()]),
    getJurisdiction: vi.fn(async (): Promise<JurisdictionRow> => buildRow()),
    upsertJurisdiction: vi.fn(async (): Promise<JurisdictionRow> => buildRow()),
    setJurisdictionVerification: vi.fn(
      async (): Promise<JurisdictionRow> =>
        buildRow({
          verified: true,
          verifiedAt: new Date('2026-07-24T15:00:00.000Z'),
          verifiedByUserId: 'user_ops_1',
        }),
    ),
    ...overrides,
  };
  return {
    controller: new MandatedReporterJurisdictionsController(
      service as unknown as MandatedReporterService,
    ),
    service,
  };
}

function staffRequest(permissions: readonly string[]): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_ops_1',
    mfaVerified: true,
    roles: [
      { name: 'trust_safety_operator', scope: { type: 'global' }, permissions },
    ] as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.7',
    headers: { 'user-agent': 'ops-console/1.0' },
  } as unknown as RequestWithContext;
}

const WRITE = ['trust_safety:write'];

describe('MandatedReporterJurisdictionsController — permission gating', () => {
  it('gates the READ routes on trust_safety:write, not a weaker :read', async () => {
    // The kit is the operating manual for an elder-abuse reporting workflow;
    // its audience is exactly the people who run that workflow.
    const { controller, service } = buildController();

    await expect(
      controller.list(undefined, staffRequest(['trust_safety:read'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.listJurisdictions).not.toHaveBeenCalled();
  });

  it('gates the write routes too', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.upsert('NY', { agencyName: 'APS' }, staffRequest(['trust_safety:read'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.setVerification('NY', { verified: true }, staffRequest([])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.upsertJurisdiction).not.toHaveBeenCalled();
    expect(service.setJurisdictionVerification).not.toHaveBeenCalled();
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.list(undefined, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('MandatedReporterJurisdictionsController.list', () => {
  it('passes unverifiedOnly through only for the literal string "true"', async () => {
    const { controller, service } = buildController();

    await controller.list('true', staffRequest(WRITE));
    await controller.list('1', staffRequest(WRITE));
    await controller.list(undefined, staffRequest(WRITE));

    expect(service.listJurisdictions.mock.calls.map((c) => c[0])).toEqual([true, false, false]);
  });

  it('projects rows through the contract schema', async () => {
    const { controller } = buildController();

    const response = await controller.list(undefined, staffRequest(WRITE));

    expect(response.jurisdictions).toEqual([
      {
        stateCode: 'NY',
        agencyName: null,
        reportingPhone: null,
        reportingUrl: null,
        statutoryDeadlineHours: null,
        platformRole: 'undetermined',
        statuteCitation: null,
        verified: false,
        verifiedAt: null,
        verifiedByUserId: null,
        notes: null,
      },
    ]);
  });
});

describe('MandatedReporterJurisdictionsController — mutations', () => {
  it('forwards the edit with an audit actor context', async () => {
    const { controller, service } = buildController();

    await controller.upsert('NY', { statutoryDeadlineHours: 24 }, staffRequest(WRITE));

    const passed = service.upsertJurisdiction.mock.calls[0]?.[0] as {
      stateCode: string;
      changes: Record<string, unknown>;
      audit: Record<string, unknown>;
    };
    expect(passed.stateCode).toBe('NY');
    expect(passed.changes).toEqual({ statutoryDeadlineHours: 24 });
    expect(passed.audit).toMatchObject({ actorUserId: 'user_ops_1' });
  });

  it('records an attestation and echoes its attribution', async () => {
    const { controller, service } = buildController();

    const response = await controller.setVerification(
      'NY',
      { verified: true },
      staffRequest(WRITE),
    );

    expect(service.setJurisdictionVerification).toHaveBeenCalledWith(
      expect.objectContaining({ stateCode: 'NY', verified: true }),
    );
    expect(response.jurisdiction.verified).toBe(true);
    expect(response.jurisdiction.verifiedByUserId).toBe('user_ops_1');
  });

  it('omits notes rather than passing undefined when absent', async () => {
    const { controller, service } = buildController();

    await controller.setVerification('NY', { verified: false }, staffRequest(WRITE));

    const passed = service.setJurisdictionVerification.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect('notes' in passed).toBe(false);
  });

  it('marks both mutating routes @Idempotent', () => {
    expect(
      Reflect.getMetadata(
        IDEMPOTENT_METADATA,
        MandatedReporterJurisdictionsController.prototype.upsert,
      ),
    ).toBeDefined();
    expect(
      Reflect.getMetadata(
        IDEMPOTENT_METADATA,
        MandatedReporterJurisdictionsController.prototype.setVerification,
      ),
    ).toBeDefined();
  });
});
