import {
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminProvider360AggregatorController } from './admin-provider-360-aggregator.controller';

/**
 * Tests for the Provider 360 aggregator (TS-305b).
 *
 * The behaviours worth pinning:
 *   - the dossier is FATAL and incidents DEGRADE (the whole point of
 *     this aggregator's failure design);
 *   - two incident calls are issued — live and resolved — because a
 *     complaint history is not the live queue, and if either fails the
 *     section degrades rather than showing half a history;
 *   - the history is ordered newest-first, not by SLA deadline;
 *   - an incident resolved between the two calls is not double-counted.
 */

const REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ts',
    mfaVerified: true,
    roles: [
      {
        name: 'trust_safety',
        permissions: ['trust_safety:read', 'trust_safety:write', 'provider:read'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_360' },
} as unknown as RequestWithContext;

const CORE = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Amara',
  headline: null,
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  dementiaSensitive: false,
  languages: [],
  cuisines: [],
  dietaryExpertise: [],
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-05-19T10:00:00.000Z',
  deletedAt: null,
};

const DOSSIER_BODY = {
  provider: CORE,
  certifications: [],
  tierHistory: [],
  backgroundCheck: {
    id: 'pbc_1',
    status: 'clear',
    completedAt: '2026-01-04T18:00:00.000Z',
    createdAt: '2026-01-04T10:00:00.000Z',
    updatedAt: '2026-01-04T18:00:00.000Z',
  },
  // TS-305d. Arrives inside the dossier — the FATAL upstream — so the
  // aggregator passes it through and it is not a second degradable
  // section.
  metrics: {
    lifetime: { state: 'no_activity' },
    recent: { state: 'no_activity' },
    windowDays: 90,
    firstObservedAt: null,
    lastObservedAt: null,
    computedAt: '2026-07-26T11:59:59.000Z',
  },
  generatedAt: '2026-07-26T11:59:59.000Z',
};

function incident(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'inc_1',
    source: 'family',
    category: 'welfare',
    severity: 'high',
    status: 'triaging',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: 'prov_1',
    reporterUserId: 'usr_9',
    openedAt: '2026-07-20T10:00:00.000Z',
    slaDueAt: '2026-07-20T18:00:00.000Z',
    resolvedAt: null,
    hasMandatedReporterCase: false,
    ...overrides,
  };
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] } as unknown as DownstreamResult;
}

interface Routed {
  readonly dossier?: DownstreamResult;
  readonly live?: DownstreamResult;
  readonly resolved?: DownstreamResult;
}

/**
 * Routes each call by path so a test can fail one upstream while the
 * others succeed — which is the entire subject of this suite.
 */
class RoutingStub {
  public readonly calls: DownstreamCallOptions[] = [];

  constructor(private readonly routed: Routed) {}

  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.calls.push(options);
    if (options.path.includes('/dossier')) {
      return (this.routed.dossier ?? ok(DOSSIER_BODY)) as DownstreamResult<TBody>;
    }
    if (options.path.includes('status=resolved')) {
      return (this.routed.resolved ?? ok({ incidents: [] })) as DownstreamResult<TBody>;
    }
    return (this.routed.live ?? ok({ incidents: [incident()] })) as DownstreamResult<TBody>;
  }
}

function build(routed: Routed = {}): {
  controller: AdminProvider360AggregatorController;
  stub: RoutingStub;
} {
  const stub = new RoutingStub(routed);
  return {
    controller: new AdminProvider360AggregatorController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

describe('AdminProvider360AggregatorController', () => {
  it('composes the dossier and the incident history', async () => {
    const { controller } = build();
    const response = await controller.getProvider360('prov_1', REQUEST);

    expect(response.provider.id).toBe('prov_1');
    expect(response.backgroundCheck?.status).toBe('clear');
    expect(response.incidents.state).toBe('available');
  });

  it('issues THREE upstream calls — the dossier, the live queue, and the resolved queue', async () => {
    const { controller, stub } = build();
    await controller.getProvider360('prov_1', REQUEST);

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.filter((c) => c.service === 'provider')).toHaveLength(1);
    expect(stub.calls.filter((c) => c.service === 'trust-safety')).toHaveLength(2);
    expect(stub.calls.some((c) => c.path.includes('status=resolved'))).toBe(true);
    // The live call must NOT pin a status — that is what makes it "every
    // incident that is not resolved".
    const live = stub.calls.find(
      (c) => c.service === 'trust-safety' && !c.path.includes('status='),
    );
    expect(live).toBeDefined();
    expect(live?.path).toContain('providerId=prov_1');
  });

  it('propagates the caller context and trace id to every upstream', async () => {
    const { controller, stub } = build();
    await controller.getProvider360('prov_1', REQUEST);

    for (const call of stub.calls) {
      expect(call.actor).toBe(REQUEST.requestContext);
      expect(call.traceId).toBe('tr_360');
    }
  });

  it('orders the history NEWEST-FIRST, not by SLA deadline', async () => {
    const { controller } = build({
      live: ok({
        incidents: [
          incident({ id: 'inc_old', openedAt: '2026-01-01T00:00:00.000Z' }),
          incident({ id: 'inc_new', openedAt: '2026-07-01T00:00:00.000Z' }),
        ],
      }),
      resolved: ok({
        incidents: [
          incident({
            id: 'inc_mid',
            status: 'resolved',
            openedAt: '2026-04-01T00:00:00.000Z',
            resolvedAt: '2026-04-05T00:00:00.000Z',
          }),
        ],
      }),
    });

    const response = await controller.getProvider360('prov_1', REQUEST);
    if (response.incidents.state !== 'available') throw new Error('expected an available section');
    expect(response.incidents.incidents.map((i) => i.id)).toEqual([
      'inc_new',
      'inc_mid',
      'inc_old',
    ]);
  });

  it('merges RESOLVED incidents into the history — a committee reads closed complaints too', async () => {
    const { controller } = build({
      live: ok({ incidents: [] }),
      resolved: ok({
        incidents: [
          incident({
            id: 'inc_closed',
            status: 'resolved',
            resolvedAt: '2026-06-01T00:00:00.000Z',
          }),
        ],
      }),
    });

    const response = await controller.getProvider360('prov_1', REQUEST);
    if (response.incidents.state !== 'available') throw new Error('expected an available section');
    expect(response.incidents.incidents.map((i) => i.id)).toEqual(['inc_closed']);
  });

  it('does not double-count an incident resolved between the two calls', async () => {
    const same = incident({ id: 'inc_racing' });
    const { controller } = build({
      live: ok({ incidents: [same] }),
      resolved: ok({ incidents: [{ ...same, status: 'resolved' }] }),
    });

    const response = await controller.getProvider360('prov_1', REQUEST);
    if (response.incidents.state !== 'available') throw new Error('expected an available section');
    expect(response.incidents.incidents).toHaveLength(1);
  });

  it('reports an EMPTY history as available, not unavailable', async () => {
    const { controller } = build({ live: ok({ incidents: [] }), resolved: ok({ incidents: [] }) });
    const response = await controller.getProvider360('prov_1', REQUEST);

    expect(response.incidents).toEqual({ state: 'available', incidents: [], truncated: false });
  });

  it.each([
    ['network_error', 'unreachable'],
    ['timeout', 'timeout'],
    ['not_configured', 'not_configured'],
  ])('degrades the incident section on a %s to reason %s', async (kind, reason) => {
    const { controller } = build({
      live: { kind, service: 'trust-safety' } as unknown as DownstreamResult,
    });

    const response = await controller.getProvider360('prov_1', REQUEST);
    expect(response.incidents).toEqual({ state: 'unavailable', reason });
    // The dossier half still rendered — that is the whole point.
    expect(response.provider.id).toBe('prov_1');
  });

  it('degrades on a malformed incident body rather than 502-ing the page', async () => {
    const { controller } = build({ live: ok({ incidents: [{ id: 'inc_bad' }] }) });
    const response = await controller.getProvider360('prov_1', REQUEST);
    expect(response.incidents).toEqual({ state: 'unavailable', reason: 'contract_drift' });
  });

  it('degrades when only the RESOLVED half fails — half a history is not a history', async () => {
    const { controller } = build({
      resolved: { kind: 'timeout', service: 'trust-safety' } as unknown as DownstreamResult,
    });

    const response = await controller.getProvider360('prov_1', REQUEST);
    expect(response.incidents).toEqual({ state: 'unavailable', reason: 'timeout' });
  });

  it('flags truncated when a page comes back at the cap', async () => {
    const many = Array.from({ length: 200 }, (_unused, index) =>
      incident({ id: `inc_${index}`, openedAt: '2026-07-20T10:00:00.000Z' }),
    );
    const { controller } = build({ live: ok({ incidents: many }) });

    const response = await controller.getProvider360('prov_1', REQUEST);
    if (response.incidents.state !== 'available') throw new Error('expected an available section');
    expect(response.incidents.truncated).toBe(true);
  });

  it('404s when the provider does not exist — the dossier is FATAL', async () => {
    const { controller } = build({
      dossier: { kind: 'client_error', status: 404, body: {} } as unknown as DownstreamResult,
    });

    await expect(controller.getProvider360('prov_gone', REQUEST)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('502s when the dossier body drifts from its contract', async () => {
    const { controller } = build({ dossier: ok({ provider: { id: 'prov_1' } }) });
    await expect(controller.getProvider360('prov_1', REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('503s when the provider service has no configured route', async () => {
    const { controller } = build({
      dossier: { kind: 'not_configured', service: 'provider' } as unknown as DownstreamResult,
    });

    await expect(controller.getProvider360('prov_1', REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('passes the metrics section through from the dossier — it is not a second degradable upstream (TS-305d)', async () => {
    const { controller } = build();
    const response = await controller.getProvider360('prov_1', REQUEST);

    expect(response.metrics).toEqual(DOSSIER_BODY.metrics);
  });

  it('carries a MEASURED metrics section through unaltered, rates and counts alike', async () => {
    const measured = {
      ...DOSSIER_BODY,
      metrics: {
        lifetime: {
          state: 'measured',
          counts: {
            bookingsOffered: 12,
            bookingsAccepted: 10,
            bookingsDeclined: 1,
            bookingsExpiredUnanswered: 1,
            bookingsDeclinedByAdmin: 0,
            bookingsCompleted: 7,
            bookingsCanceledAfterAcceptance: 1,
            decidedBookings: 8,
          },
          completionRate: 875,
          cancellationRate: 125,
          acceptanceRate: 833,
          medianResponseSeconds: 1800,
        },
        recent: { state: 'no_activity' },
        windowDays: 90,
        firstObservedAt: '2026-01-04T10:00:00.000Z',
        lastObservedAt: '2026-07-20T10:00:00.000Z',
        computedAt: '2026-07-26T11:59:59.000Z',
      },
    };
    const { controller } = build({ dossier: ok(measured) });
    const response = await controller.getProvider360('prov_1', REQUEST);

    expect(response.metrics).toEqual(measured.metrics);
  });

  it('stamps generatedAt at the GATEWAY, not from the dossier', async () => {
    const { controller } = build();
    const response = await controller.getProvider360('prov_1', REQUEST);
    expect(response.generatedAt).not.toBe(DOSSIER_BODY.generatedAt);
  });

  it('requires BOTH trust_safety:write and provider:read', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminProvider360AggregatorController.prototype.getProvider360,
    ) as unknown;

    expect(permissions).toEqual(['trust_safety:write', 'provider:read']);
  });

  it('applies AccessTokenGuard → PermissionGuard → RateLimitGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminProvider360AggregatorController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });
});
