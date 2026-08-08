import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
} from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminTrustSafetyIncidentsProxyController } from './admin-trust-safety-incidents-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-07-18T10:00:00.000Z';

const CONCIERGE_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_concierge',
    mfaVerified: true,
    roles: [
      {
        name: 'concierge_lead',
        permissions: ['concierge:read', 'concierge:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_onbehalf' },
} as unknown as RequestWithContext;

const RECEIPT = {
  incidentId: 'inc_9',
  category: 'welfare' as const,
  openedAt: NOW_ISO,
};

const VALID_BODY = {
  householdId: 'hh_5',
  category: 'welfare',
  description: 'Daughter called the concierge line about a missed visit.',
};

function buildController(stub: StubDownstreamClient): AdminTrustSafetyIncidentsProxyController {
  return new AdminTrustSafetyIncidentsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 201, body, setCookies: [] };
}

describe('AdminTrustSafetyIncidentsProxyController.reportOnBehalf', () => {
  it('forwards a valid on-behalf report to the admin downstream path', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    const response = await controller.reportOnBehalf(
      VALID_BODY,
      'admin-concern-hh_5-abc',
      CONCIERGE_REQUEST,
    );

    expect(response.receipt.incidentId).toBe('inc_9');
    expect(stub.lastOptions?.service).toBe('trust-safety');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/trust-safety/incidents');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_concierge');
    expect(stub.lastOptions?.traceId).toBe('tr_test_onbehalf');
    expect(stub.lastOptions?.idempotencyKey).toBe('admin-concern-hh_5-abc');
  });

  it('forwards the body householdId — this is the only route where it is accepted', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    await controller.reportOnBehalf(
      { ...VALID_BODY, householdId: 'hh_77' },
      undefined,
      CONCIERGE_REQUEST,
    );

    expect(stub.lastOptions?.body).toMatchObject({ householdId: 'hh_77' });
  });

  it('rejects a body missing householdId without a downstream round trip', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    await expect(
      controller.reportOnBehalf(
        { category: 'welfare', description: 'no household named' },
        undefined,
        CONCIERGE_REQUEST,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream body drifts from the receipt contract (leak firewall)', async () => {
    const stub = new StubDownstreamClient(
      ok({ receipt: { ...RECEIPT, severity: 'high', slaDueAt: NOW_ISO } }),
    );
    const controller = buildController(stub);

    await expect(
      controller.reportOnBehalf(VALID_BODY, undefined, CONCIERGE_REQUEST),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('passes a downstream 403 (permission re-check) through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'concierge:write' },
    } as DownstreamResult);
    const controller = buildController(stub);

    try {
      await controller.reportOnBehalf(VALID_BODY, undefined, CONCIERGE_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
    }
  });

  it('503s with the env-var name when trust-safety is not configured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'trust-safety',
    } as DownstreamResult);
    const controller = buildController(stub);

    try {
      await controller.reportOnBehalf(VALID_BODY, undefined, CONCIERGE_REQUEST);
      throw new Error('unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toContain('TRUST_SAFETY_SERVICE_BASE_URL');
    }
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ receipt: RECEIPT }));
    const controller = buildController(stub);

    await expect(
      controller.reportOnBehalf(VALID_BODY, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminTrustSafetyIncidentsProxyController — guard metadata', () => {
  it('wears AccessTokenGuard + PermissionGuard + RateLimitGuard, in that order', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminTrustSafetyIncidentsProxyController,
    ) as unknown[];
    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });

  it('gates the on-behalf route on concierge:write', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminTrustSafetyIncidentsProxyController.prototype.reportOnBehalf,
    ) as unknown;
    expect(permissions).toEqual(['concierge:write']);
  });
});

const OPS_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ops_1',
    mfaVerified: true,
    roles: [
      {
        name: 'trust_safety',
        permissions: ['trust_safety:read', 'trust_safety:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_queue' },
} as unknown as RequestWithContext;

const INCIDENT_SUMMARY = {
  id: 'inc_1',
  source: 'family' as const,
  category: 'welfare' as const,
  severity: 'high' as const,
  status: 'open' as const,
  householdId: 'hh_1',
  seniorId: 'sen_1',
  providerId: null,
  reporterUserId: 'usr_filer',
  openedAt: NOW_ISO,
  slaDueAt: '2026-07-18T18:00:00.000Z',
  resolvedAt: null,
  hasMandatedReporterCase: false,
};

function ok200(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminTrustSafetyIncidentsProxyController — TS-303c2d permission split', () => {
  it('gates the queue on trust_safety:read and the detail on trust_safety:write', () => {
    // Three permissions on one path prefix, deliberately: filing on a
    // household's behalf, triaging the queue, and reading a report are three
    // different authorities.
    const required = (method: string): string[] =>
      Reflect.getMetadata(
        REQUIRE_PERMISSIONS_METADATA_KEY,
        (AdminTrustSafetyIncidentsProxyController.prototype as unknown as Record<string, unknown>)[
          method
        ] as object,
      ) as string[];

    expect(required('reportOnBehalf')).toEqual(['concierge:write']);
    expect(required('listIncidents')).toEqual(['trust_safety:read']);
    expect(required('getIncident')).toEqual(['trust_safety:write']);
  });

  it('still applies AccessTokenGuard → PermissionGuard → RateLimitGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminTrustSafetyIncidentsProxyController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });
});

describe('AdminTrustSafetyIncidentsProxyController.listIncidents (TS-303c2d)', () => {
  it('forwards the queue read with the default limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok200({ incidents: [INCIDENT_SUMMARY] }));

    const response = await buildController(stub).listIncidents({}, OPS_REQUEST);

    expect(stub.lastOptions).toMatchObject({
      service: 'trust-safety',
      path: '/api/v1/admin/trust-safety/incidents?limit=50',
      method: 'GET',
      traceId: 'tr_test_queue',
    });
    expect(response.incidents).toHaveLength(1);
  });

  it('forwards every filter in a stable order', async () => {
    const stub = new StubDownstreamClient(ok200({ incidents: [] }));

    await buildController(stub).listIncidents(
      {
        status: 'triaging',
        severity: 'critical',
        category: 'safety',
        householdId: 'hh_9',
        seniorId: 'sen_9',
        providerId: 'prv_9',
        limit: '10',
      },
      OPS_REQUEST,
    );

    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/trust-safety/incidents?status=triaging&severity=critical&category=safety&householdId=hh_9&seniorId=sen_9&providerId=prv_9&limit=10',
    );
  });

  it('400s an unknown query key at the edge — nothing unvalidated reaches downstream', async () => {
    const stub = new StubDownstreamClient(ok200({ incidents: [] }));

    await expect(
      buildController(stub).listIncidents({ orderBy: 'severity' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s an over-cap limit and an unknown severity at the edge', async () => {
    const stub = new StubDownstreamClient(ok200({ incidents: [] }));

    await expect(
      buildController(stub).listIncidents({ limit: '5000' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      buildController(stub).listIncidents({ severity: 'catastrophic' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream list body carries the filer narrative', async () => {
    // Contract drift in the leak-prone direction: `.strict()` on the summary
    // turns a widened downstream projection into a 502 rather than relaying a
    // family's account of a named senior to a list surface.
    const leaky = {
      incidents: [{ ...INCIDENT_SUMMARY, description: 'she seemed frightened' }],
    };
    const stub = new StubDownstreamClient(ok200(leaky));

    await expect(buildController(stub).listIncidents({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok200({ incidents: [] }));

    await expect(
      buildController(stub).listIncidents({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('503s when TRUST_SAFETY_SERVICE_BASE_URL is unconfigured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'trust-safety',
    } as unknown as DownstreamResult);

    await expect(buildController(stub).listIncidents({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminTrustSafetyIncidentsProxyController.getIncident (TS-303c2d)', () => {
  const DETAIL = {
    incident: {
      ...INCIDENT_SUMMARY,
      description: 'she seemed frightened of her afternoon visitor',
      resolutionNotes: null,
      // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake
      // trail. Null on a human-filed report, which this fixture is; the
      // proxy re-validates against the contract, so a detail response
      // missing them is a 502, not a partial body.
      sourceEventId: null,
      detector: null,
      systemEvidence: null,
    },
  };

  it('forwards the detail read and url-encodes the id', async () => {
    const stub = new StubDownstreamClient(ok200(DETAIL));

    const response = await buildController(stub).getIncident('inc/../evil', OPS_REQUEST);

    expect(stub.lastOptions?.path).toBe('/api/v1/admin/trust-safety/incidents/inc%2F..%2Fevil');
    expect(response.incident.description).toBe('she seemed frightened of her afternoon visitor');
  });

  it('passes a downstream 404 through verbatim', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'incident not found',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: problem,
      setCookies: [],
    } as unknown as DownstreamResult);

    await expect(buildController(stub).getIncident('inc_nope', OPS_REQUEST)).rejects.toMatchObject({
      response: problem,
    });
  });

  it('502s on a detail body that does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(ok200({ incident: { id: 'inc_1' } }));

    await expect(buildController(stub).getIncident('inc_1', OPS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
