import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { describe, expect, it, vi } from 'vitest';

import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentsService } from '../services/incidents.service';
import { AdminIncidentResolutionController } from './admin-incident-resolution.controller';

const T0 = new Date('2026-07-24T12:00:00.000Z');
const RESOLVED_AT = new Date('2026-07-25T09:30:00.000Z');

function buildRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: null,
    reporterUserId: 'user_family',
    source: 'family',
    category: 'welfare',
    severity: 'high',
    status: 'resolved',
    description: 'a concern',
    openedAt: T0,
    slaDueAt: new Date('2026-07-24T20:00:00.000Z'),
    resolvedAt: RESOLVED_AT,
    resolutionNotes: 'spoke with the family',
    // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake trail.
    // Null here: these fixtures are human-filed reports.
    sourceEventId: null,
    detector: null,
    systemFacts: null,
    createdAt: T0,
    updatedAt: RESOLVED_AT,
    ...overrides,
  };
}

interface FakeService {
  resolveIncident: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: AdminIncidentResolutionController;
  service: FakeService;
} {
  const service: FakeService = {
    resolveIncident: vi.fn(async (): Promise<IncidentRow> => buildRow()),
    ...overrides,
  };
  return {
    controller: new AdminIncidentResolutionController(service as unknown as IncidentsService),
    service,
  };
}

function staffRequest(permissions: readonly string[], userId = 'user_ops_1'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
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

const BODY = { resolutionNotes: 'spoke with the family; no further concern' } as const;

describe('AdminIncidentResolutionController.resolve', () => {
  it('resolves the incident and echoes the closure', async () => {
    const { controller, service } = buildController();

    const response = await controller.resolve('inc_1', BODY, staffRequest(['trust_safety:write']));

    expect(service.resolveIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: 'inc_1',
        resolutionNotes: 'spoke with the family; no further concern',
      }),
    );
    expect(response).toEqual({
      incidentId: 'inc_1',
      status: 'resolved',
      resolvedAt: RESOLVED_AT.toISOString(),
    });
  });

  it('passes an audit actor context — closing an incident is an admin mutation', async () => {
    const { controller, service } = buildController();

    await controller.resolve('inc_1', BODY, staffRequest(['trust_safety:write'], 'user_ops_9'));

    const passed = service.resolveIncident.mock.calls[0]?.[0] as {
      audit: Record<string, unknown>;
    };
    expect(passed.audit).toMatchObject({
      actorUserId: 'user_ops_9',
      ip: '203.0.113.7',
      userAgent: 'ops-console/1.0',
    });
  });

  it('requires trust_safety:write, not concierge:write', async () => {
    // A concierge who may file a concern on a household's behalf is not
    // thereby authorised to close one.
    const { controller, service } = buildController();

    await expect(
      controller.resolve('inc_1', BODY, staffRequest(['concierge:write'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.resolveIncident).not.toHaveBeenCalled();
  });

  it('rejects an actor with no permissions with 403', async () => {
    const { controller } = buildController();

    await expect(controller.resolve('inc_1', BODY, staffRequest([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const { controller } = buildController();

    await expect(
      controller.resolve('inc_1', BODY, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('surfaces the service 409 when the never-auto-close gate blocks', async () => {
    const { controller } = buildController({
      resolveIncident: vi.fn(async () => {
        throw Object.assign(new Error('blocked'), { status: 409 });
      }),
    });

    await expect(
      controller.resolve('inc_1', BODY, staffRequest(['trust_safety:write'])),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is marked @Idempotent so a double-submit cannot double-close', async () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_METADATA, AdminIncidentResolutionController.prototype.resolve),
    ).toBeDefined();
  });
});
