import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { AdminReportConcernRequest } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentsService } from '../services/incidents.service';
import { AdminReportConcernController } from './admin-report-concern.controller';

const T0 = new Date('2026-07-18T10:00:00.000Z');

function buildRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_9',
    householdId: 'hh_5',
    seniorId: null,
    providerId: null,
    reporterUserId: 'user_concierge',
    source: 'concierge',
    category: 'welfare',
    severity: 'high',
    status: 'open',
    description: 'Daughter called the concierge line about a missed visit.',
    openedAt: T0,
    slaDueAt: new Date('2026-07-18T18:00:00.000Z'),
    resolvedAt: null,
    resolutionNotes: null,
    // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake trail.
    // Null here: these fixtures are human-filed reports.
    sourceEventId: null,
    detector: null,
    systemFacts: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface FakeService {
  createIncident: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: AdminReportConcernController;
  service: FakeService;
} {
  const service: FakeService = {
    createIncident: vi.fn(async (): Promise<IncidentRow> => buildRow()),
    ...overrides,
  };
  const controller = new AdminReportConcernController(service as unknown as IncidentsService);
  return { controller, service };
}

/** A staff token carrying an explicit permission set at global scope. */
function staffRequest(
  permissions: readonly string[],
  userId = 'user_concierge',
): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [
      { name: 'concierge_lead', scope: { type: 'global' }, permissions },
    ] as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

const VALID_BODY: AdminReportConcernRequest = {
  householdId: 'hh_5',
  category: 'welfare',
  description: 'Daughter called the concierge line about a missed visit.',
};

describe('AdminReportConcernController.reportOnBehalf', () => {
  it('files against the body-supplied household when the actor holds concierge:write', async () => {
    const { controller, service } = buildController();

    await controller.reportOnBehalf(
      { ...VALID_BODY, householdId: 'hh_77' },
      staffRequest(['concierge:write']),
    );

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: 'hh_77', source: 'concierge' }),
    );
  });

  it('attributes the incident to the concierge who filed it, not the household', async () => {
    const { controller, service } = buildController();

    await controller.reportOnBehalf(VALID_BODY, staffRequest(['concierge:write'], 'user_cx_3'));

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ reporterUserId: 'user_cx_3' }),
    );
  });

  it('re-checks concierge:write downstream — a token without it gets 403', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.reportOnBehalf(VALID_BODY, staffRequest(['concierge:read'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.createIncident).not.toHaveBeenCalled();
  });

  it('rejects an actor with no permissions at all with 403', async () => {
    const { controller, service } = buildController();

    await expect(controller.reportOnBehalf(VALID_BODY, staffRequest([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.createIncident).not.toHaveBeenCalled();
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.reportOnBehalf(VALID_BODY, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('applies the same category-default severity as the filer-facing route', async () => {
    const { controller, service } = buildController();

    for (const [category, severity] of [
      ['welfare', 'high'],
      ['safety', 'high'],
      ['billing', 'medium'],
      ['conduct', 'medium'],
    ] as const) {
      service.createIncident.mockClear();
      await controller.reportOnBehalf(
        { ...VALID_BODY, category },
        staffRequest(['concierge:write']),
      );
      expect(service.createIncident).toHaveBeenCalledWith(
        expect.objectContaining({ category, severity }),
      );
    }
  });

  it('passes the optional seniorId through when named', async () => {
    const { controller, service } = buildController();

    await controller.reportOnBehalf(
      { ...VALID_BODY, seniorId: 'sen_2' },
      staffRequest(['concierge:write']),
    );

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ seniorId: 'sen_2' }),
    );
  });

  it('returns the same minimal receipt as the filer-facing route', async () => {
    const { controller } = buildController();

    const response = await controller.reportOnBehalf(VALID_BODY, staffRequest(['concierge:write']));

    expect(response.receipt).toEqual({
      incidentId: 'inc_9',
      category: 'welfare',
      openedAt: T0.toISOString(),
    });
  });

  it('wears @Idempotent() — a retried on-behalf submit returns the cached receipt', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      AdminReportConcernController.prototype.reportOnBehalf,
    ) as unknown;
    expect(flag).toBe(true);
  });
});
