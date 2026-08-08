import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ReportConcernRequest } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentsService } from '../services/incidents.service';
import {
  DEFAULT_SEVERITY_BY_CATEGORY,
  ReportConcernController,
  deriveSource,
} from './report-concern.controller';

const T0 = new Date('2026-07-02T10:00:00.000Z');

function buildRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_1',
    householdId: 'hh_1',
    seniorId: null,
    providerId: null,
    reporterUserId: 'user_filer',
    source: 'family',
    category: 'welfare',
    severity: 'high',
    status: 'open',
    description: 'Mom seemed frightened of her afternoon visitor.',
    openedAt: T0,
    slaDueAt: new Date('2026-07-02T18:00:00.000Z'),
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
  controller: ReportConcernController;
  service: FakeService;
} {
  const service: FakeService = {
    createIncident: vi.fn(async (): Promise<IncidentRow> => buildRow()),
    ...overrides,
  };
  const controller = new ReportConcernController(service as unknown as IncidentsService);
  return { controller, service };
}

function householdRequest(
  householdId = 'hh_1',
  roleNames: readonly string[] = ['family_payer'],
): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_filer',
    mfaVerified: false,
    roles: roleNames.map((name) => ({
      name,
      scope: { type: 'household', householdId },
      permissions: [],
    })) as unknown as RequestContext['roles'],
    tenantScope: { type: 'household', householdId },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

function globalRequest(roleNames: readonly string[] = []): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_admin',
    mfaVerified: true,
    roles: roleNames.map((name) => ({
      name,
      scope: { type: 'global' },
      permissions: [],
    })) as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

/** A provider token: global scope + the `provider` role, no household. */
function providerRequest(userId = 'user_provider'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: false,
    roles: [
      { name: 'provider', scope: { type: 'global' }, permissions: [] },
    ] as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

/** A partner-tenant token — neither a household member nor a provider. */
function tenantRequest(): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'user_partner',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'tenant', tenantId: 'tnt_1' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

const VALID_BODY: ReportConcernRequest = {
  category: 'welfare',
  description: 'Mom seemed frightened of her afternoon visitor.',
};

describe('ReportConcernController.report', () => {
  it('files for the household resolved from the token scope — never the body', async () => {
    const { controller, service } = buildController();

    await controller.report(VALID_BODY, householdRequest('hh_42'));

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: 'hh_42', category: 'welfare', source: 'family' }),
    );
  });

  it('derives source=senior when the actor holds senior_user', async () => {
    const { controller, service } = buildController();

    await controller.report(VALID_BODY, householdRequest('hh_1', ['senior_user']));

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'senior' }),
    );
  });

  it('assigns the category-default severity (welfare/safety high; billing/conduct medium)', async () => {
    const { controller, service } = buildController();

    for (const [category, severity] of [
      ['welfare', 'high'],
      ['safety', 'high'],
      ['billing', 'medium'],
      ['conduct', 'medium'],
    ] as const) {
      service.createIncident.mockClear();
      await controller.report({ ...VALID_BODY, category }, householdRequest());
      expect(service.createIncident).toHaveBeenCalledWith(
        expect.objectContaining({ category, severity }),
      );
    }
  });

  it('passes the description through to persistence and the optional seniorId when named', async () => {
    const { controller, service } = buildController();

    await controller.report({ ...VALID_BODY, seniorId: 'sen_7' }, householdRequest());

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ description: VALID_BODY.description, seniorId: 'sen_7' }),
    );
  });

  it('returns the minimal receipt — no severity / SLA / status internals', async () => {
    const { controller } = buildController();

    const response = await controller.report(VALID_BODY, householdRequest());

    expect(response.receipt).toEqual({
      incidentId: 'inc_1',
      category: 'welfare',
      openedAt: T0.toISOString(),
    });
    expect(Object.keys(response.receipt)).not.toContain('severity');
    expect(Object.keys(response.receipt)).not.toContain('slaDueAt');
  });

  it('stamps reporterUserId from the verified token subject', async () => {
    const { controller, service } = buildController();

    await controller.report(VALID_BODY, householdRequest());

    expect(service.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ reporterUserId: 'user_filer' }),
    );
  });

  it('rejects a global actor with no provider role with 400', async () => {
    const { controller, service } = buildController();

    await expect(controller.report(VALID_BODY, globalRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.createIncident).not.toHaveBeenCalled();
  });

  it('rejects a partner-tenant actor with 400', async () => {
    const { controller, service } = buildController();

    await expect(controller.report(VALID_BODY, tenantRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.createIncident).not.toHaveBeenCalled();
  });

  it('admits a provider token: source=provider, no household, anchored on the reporter', async () => {
    const { controller, service } = buildController();

    await controller.report(VALID_BODY, providerRequest('user_prov_9'));

    const input = service.createIncident.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input['source']).toBe('provider');
    expect(input['reporterUserId']).toBe('user_prov_9');
    // No household on a provider report — and critically no providerId, which
    // the body can never assert (that would let a provider pin a concern on
    // another provider). Linkage happens at triage.
    expect(input).not.toHaveProperty('householdId');
    expect(input['providerId']).toBeUndefined();
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.report(VALID_BODY, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('wears @Idempotent() — a retried submit returns the cached receipt', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      ReportConcernController.prototype.report,
    ) as unknown;
    expect(flag).toBe(true);
  });
});

describe('deriveSource / DEFAULT_SEVERITY_BY_CATEGORY', () => {
  it('senior_user among several roles still derives senior', () => {
    const ctx = {
      userId: 'u',
      mfaVerified: false,
      roles: [{ name: 'family_observer' }, { name: 'senior_user' }],
      tenantScope: { type: 'household', householdId: 'hh_1' },
    } as unknown as RequestContext;
    expect(deriveSource(ctx)).toBe('senior');
  });

  it('covers every intake category with a default severity', () => {
    expect(Object.keys(DEFAULT_SEVERITY_BY_CATEGORY).sort()).toEqual([
      'billing',
      'conduct',
      'safety',
      'welfare',
    ]);
  });
});
