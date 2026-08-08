import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import type { IncidentDetailRow, IncidentSummaryRow } from '../repositories/incident.repository';
import { IncidentsService } from '../services/incidents.service';
import { AdminIncidentsReadController } from './admin-incidents-read.controller';

const T0 = new Date('2026-07-25T12:00:00.000Z');

function buildSummary(overrides: Partial<IncidentSummaryRow> = {}): IncidentSummaryRow {
  return {
    id: 'inc_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: null,
    reporterUserId: 'usr_filer',
    source: 'family',
    category: 'welfare',
    severity: 'high',
    status: 'open',
    openedAt: T0,
    slaDueAt: new Date('2026-07-25T20:00:00.000Z'),
    resolvedAt: null,
    hasMandatedReporterCase: false,
    ...overrides,
  };
}

function buildDetail(overrides: Partial<IncidentDetailRow> = {}): IncidentDetailRow {
  return {
    ...buildSummary(),
    description: 'she seemed frightened of her afternoon visitor',
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
  listIncidents: ReturnType<typeof vi.fn>;
  getIncidentDetail: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: AdminIncidentsReadController;
  service: FakeService;
} {
  const service: FakeService = {
    listIncidents: vi.fn(async (): Promise<IncidentSummaryRow[]> => [buildSummary()]),
    getIncidentDetail: vi.fn(async (): Promise<IncidentDetailRow> => buildDetail()),
    ...overrides,
  };
  return {
    controller: new AdminIncidentsReadController(service as unknown as IncidentsService),
    service,
  };
}

function staffRequest(permissions: readonly string[]): RequestWithContext {
  const ctx: RequestContext = {
    userId: 'usr_ops_1',
    mfaVerified: true,
    roles: [
      { name: 'trust_safety', scope: { type: 'global' }, permissions },
    ] as unknown as RequestContext['roles'],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.7',
    headers: { 'user-agent': 'ops-console/1.0' },
  } as unknown as RequestWithContext;
}

/**
 * The permission SPLIT is what this suite is mostly about. The queue is a
 * `trust_safety:read` surface; the detail is `trust_safety:write`, because it
 * carries a family's free-text account of what happened to a named senior. A
 * regression that let `:read` reach the narrative is the failure this file
 * exists to catch.
 */
describe('AdminIncidentsReadController — permission split', () => {
  it('lets a read-only actor see the queue', async () => {
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents).toHaveLength(1);
  });

  it('refuses the DETAIL to a read-only actor — the narrative needs write', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.get('inc_1', staffRequest(['trust_safety:read'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getIncidentDetail).not.toHaveBeenCalled();
  });

  it('lets a write actor read the detail', async () => {
    const { controller } = buildController();

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident.description).toBe('she seemed frightened of her afternoon visitor');
  });

  it('refuses the queue to an actor holding neither permission', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.list({ limit: 50 }, staffRequest(['concierge:write'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.listIncidents).not.toHaveBeenCalled();
  });

  it.each([
    ['list', (c: AdminIncidentsReadController, r: RequestWithContext) => c.list({ limit: 50 }, r)],
    ['get', (c: AdminIncidentsReadController, r: RequestWithContext) => c.get('inc_1', r)],
  ])('throws 401 on %s when no request context is attached', async (_name, call) => {
    const { controller } = buildController();

    await expect(
      call(controller, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminIncidentsReadController.list', () => {
  it('never emits the free-text fields on a list read', async () => {
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents[0]).not.toHaveProperty('description');
    expect(response.incidents[0]).not.toHaveProperty('resolutionNotes');
  });

  it('forwards every filter to the service', async () => {
    const { controller, service } = buildController();

    await controller.list(
      {
        status: 'triaging',
        severity: 'critical',
        category: 'safety',
        householdId: 'hh_9',
        seniorId: 'sen_9',
        providerId: 'prv_9',
        limit: 10,
      },
      staffRequest(['trust_safety:read']),
    );

    expect(service.listIncidents).toHaveBeenCalledWith({
      status: 'triaging',
      severity: 'critical',
      category: 'safety',
      householdId: 'hh_9',
      seniorId: 'sen_9',
      providerId: 'prv_9',
      limit: 10,
    });
  });

  it('leaves filters undefined when absent — the service defaults to live work', async () => {
    const { controller, service } = buildController();

    await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(service.listIncidents).toHaveBeenCalledWith({
      status: undefined,
      severity: undefined,
      category: undefined,
      householdId: undefined,
      seniorId: undefined,
      providerId: undefined,
      limit: 50,
    });
  });

  it('carries the statutory-pathway flag so the queue can show what cannot be closed', async () => {
    const { controller } = buildController({
      listIncidents: vi.fn(async () => [buildSummary({ hasMandatedReporterCase: true })]),
    });

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents[0]?.hasMandatedReporterCase).toBe(true);
  });

  it('serialises a null resolvedAt as null', async () => {
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents[0]?.resolvedAt).toBeNull();
  });

  it('returns an empty queue as an empty array', async () => {
    const { controller } = buildController({ listIncidents: vi.fn(async () => []) });

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents).toEqual([]);
  });
});

const TRAVEL_EVIDENCE = {
  detector: 'impossible_travel',
  previousCheckInId: 'ci_1',
  checkInId: 'ci_2',
  previousBookingId: 'bkg_1',
  bookingId: 'bkg_2',
  distanceMeters: 812_000,
  elapsedSeconds: 3_900,
  impliedSpeedKph: 749.5,
  thresholdKph: 1_000,
  previousOccurredAt: '2026-07-25T09:00:00.000Z',
  occurredAt: '2026-07-25T10:05:00.000Z',
} as const;

describe('AdminIncidentsReadController.get — system evidence (TS-308c-followup-2)', () => {
  it('surfaces the detector, its evidence, and the source event id', async () => {
    // The gap this closes: before it, an operator opening a
    // system-sourced incident saw a category, a severity, a subject and
    // NOTHING about what happened.
    const { controller } = buildController({
      getIncidentDetail: vi.fn(
        async (): Promise<IncidentDetailRow> =>
          buildDetail({
            source: 'system',
            description: null,
            reporterUserId: null,
            sourceEventId: 'impossible-travel:ci_1:ci_2',
            detector: 'impossible_travel',
            systemFacts: { ...TRAVEL_EVIDENCE },
          }),
      ),
    });

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident.sourceEventId).toBe('impossible-travel:ci_1:ci_2');
    expect(response.incident.detector).toBe('impossible_travel');
    expect(response.incident.systemEvidence).toEqual(TRAVEL_EVIDENCE);
  });

  it('returns nulls for a human-filed report', async () => {
    const { controller } = buildController();

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident.sourceEventId).toBeNull();
    expect(response.incident.detector).toBeNull();
    expect(response.incident.systemEvidence).toBeNull();
  });

  it('DEGRADES to null evidence when a stored blob no longer parses — and keeps the detector', async () => {
    // The contract will evolve, and what is in the column is whatever a
    // previous build wrote. Throwing here would lock an operator out of
    // the incident entirely over a supplementary field — strictly worse
    // than the failure this slice exists to fix. The separately-stored
    // detector is why the page can still say WHO opened it.
    const { controller } = buildController({
      getIncidentDetail: vi.fn(
        async (): Promise<IncidentDetailRow> =>
          buildDetail({
            source: 'system',
            detector: 'impossible_travel',
            systemFacts: { detector: 'impossible_travel', somethingRemoved: true },
          }),
      ),
    });

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident.systemEvidence).toBeNull();
    expect(response.incident.detector).toBe('impossible_travel');
  });

  it('nulls a detector name the contract does not recognise', async () => {
    // The column is TEXT so a fourth detector needs no migration, which
    // makes the read path the place an unknown value has to be handled.
    const { controller } = buildController({
      getIncidentDetail: vi.fn(
        async (): Promise<IncidentDetailRow> =>
          buildDetail({ source: 'system', detector: 'some_future_detector' }),
      ),
    });

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident.detector).toBeNull();
  });

  it('keeps the evidence OFF the queue rows', async () => {
    // A list read has no business pulling a JSONB blob per row for
    // something the queue does not render — enforced in the projection,
    // asserted here so a later mapper edit cannot quietly add it.
    const { controller } = buildController();

    const response = await controller.list({ limit: 50 }, staffRequest(['trust_safety:read']));

    expect(response.incidents[0]).not.toHaveProperty('systemEvidence');
    expect(response.incidents[0]).not.toHaveProperty('detector');
    expect(response.incidents[0]).not.toHaveProperty('sourceEventId');
  });
});

describe('AdminIncidentsReadController.get', () => {
  it('projects through the contract schema, timestamps included', async () => {
    const { controller } = buildController();

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident).toMatchObject({
      id: 'inc_1',
      openedAt: '2026-07-25T12:00:00.000Z',
      slaDueAt: '2026-07-25T20:00:00.000Z',
      resolvedAt: null,
      resolutionNotes: null,
    });
  });

  it('does not leak the row timestamps the contract does not declare', async () => {
    // `.strict()` on the response schema would throw if `createdAt` rode
    // along — asserting it here names the reason rather than relying on the
    // schema failing silently in some future refactor.
    const { controller } = buildController();

    const response = await controller.get('inc_1', staffRequest(['trust_safety:write']));

    expect(response.incident).not.toHaveProperty('createdAt');
    expect(response.incident).not.toHaveProperty('updatedAt');
  });

  it('passes the incident id through to the service verbatim', async () => {
    const { controller, service } = buildController();

    await controller.get('inc_weird/../id', staffRequest(['trust_safety:write']));

    expect(service.getIncidentDetail).toHaveBeenCalledWith('inc_weird/../id');
  });
});
