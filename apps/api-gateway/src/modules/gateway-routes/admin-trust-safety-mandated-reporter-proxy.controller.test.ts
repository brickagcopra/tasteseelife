import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
} from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';
import { AdminTrustSafetyMandatedReporterProxyController } from './admin-trust-safety-mandated-reporter-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const OPENED_AT = '2026-07-24T12:00:00.000Z';

const OPS_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ops_1',
    mfaVerified: true,
    roles: [
      {
        name: 'trust_safety_operator',
        permissions: ['trust_safety:read', 'trust_safety:write'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_mrc' },
} as unknown as RequestWithContext;

const CASE_BODY = {
  case: {
    id: 'mrc_1',
    incidentId: 'inc_1',
    stateCode: 'NY',
    status: 'screening' as const,
    openedByUserId: 'usr_ops_1',
    openedAt: OPENED_AT,
    statutoryDueAt: null,
    filedAt: null,
    filingReference: null,
    determinationNotes: null,
    reviewerUserId: null,
    reviewedAt: null,
    reviewerNotes: null,
  },
};

function buildController(
  stub: StubDownstreamClient,
): AdminTrustSafetyMandatedReporterProxyController {
  return new AdminTrustSafetyMandatedReporterProxyController(
    stub as unknown as DownstreamHttpClient,
  );
}

function ok(body: unknown, status = 200): DownstreamResult {
  return { kind: 'ok', status, body, setCookies: [] };
}

describe('AdminTrustSafetyMandatedReporterProxyController — guards + permissions', () => {
  it('applies AccessTokenGuard → PermissionGuard → RateLimitGuard in that order', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminTrustSafetyMandatedReporterProxyController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });

  it.each([
    ['openCase'],
    ['advanceCase'],
    ['getCaseByIncident'],
    ['listCases'],
    ['resolveIncident'],
  ])('gates %s on trust_safety:write', (method) => {
    const required = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      (
        AdminTrustSafetyMandatedReporterProxyController.prototype as unknown as Record<
          string,
          unknown
        >
      )[method] as object,
    ) as string[];

    expect(required).toEqual(['trust_safety:write']);
  });
});

describe('AdminTrustSafetyMandatedReporterProxyController — routing', () => {
  it('forwards an open to the trust-safety service with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(CASE_BODY, 201));

    await buildController(stub).openCase(
      { incidentId: 'inc_1', stateCode: 'NY' },
      'idem_1',
      OPS_REQUEST,
    );

    expect(stub.lastOptions).toMatchObject({
      service: 'trust-safety',
      path: '/api/v1/admin/trust-safety/mandated-reporter/cases',
      method: 'POST',
      idempotencyKey: 'idem_1',
      traceId: 'tr_test_mrc',
    });
  });

  it('url-encodes the case id on the transition path', async () => {
    const stub = new StubDownstreamClient(ok(CASE_BODY));

    await buildController(stub).advanceCase(
      'mrc/../evil',
      { to: 'not_reportable' },
      undefined,
      OPS_REQUEST,
    );

    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/trust-safety/mandated-reporter/cases/mrc%2F..%2Fevil/transitions',
    );
  });

  it('forwards the resolution route to the incident sub-resource', async () => {
    const stub = new StubDownstreamClient(
      ok({ incidentId: 'inc_1', status: 'resolved', resolvedAt: OPENED_AT }),
    );

    await buildController(stub).resolveIncident(
      'inc_1',
      { resolutionNotes: 'closed' },
      undefined,
      OPS_REQUEST,
    );

    expect(stub.lastOptions).toMatchObject({
      path: '/api/v1/admin/trust-safety/incidents/inc_1/resolution',
      method: 'POST',
    });
  });

  it('rejects a malformed open payload at the edge without calling downstream', async () => {
    const stub = new StubDownstreamClient(ok(CASE_BODY, 201));

    await expect(
      buildController(stub).openCase({ stateCode: 'NY' }, undefined, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects `screening` as a transition target — nothing moves back into the birth state', async () => {
    const stub = new StubDownstreamClient(ok(CASE_BODY));

    await expect(
      buildController(stub).advanceCase('mrc_1', { to: 'screening' }, undefined, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(CASE_BODY, 201));

    await expect(
      buildController(stub).openCase({ incidentId: 'inc_1', stateCode: 'NY' }, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminTrustSafetyMandatedReporterProxyController — downstream failure mapping', () => {
  it("passes a downstream 422 through verbatim — the unverified-jurisdiction explanation is the operator's", async () => {
    const problem = {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: "the mandated-reporter kit for 'NY' has not been verified by compliance",
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: problem,
      setCookies: [],
    } as unknown as DownstreamResult);

    await expect(
      buildController(stub).advanceCase('mrc_1', { to: 'filing_prep' }, undefined, OPS_REQUEST),
    ).rejects.toMatchObject({ response: problem });
  });

  it("passes a downstream 409 through verbatim — the blocked-closure explanation is the operator's", async () => {
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail:
        'incident has an open mandated-reporter case and cannot be resolved until a reviewer signs off',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: problem,
      setCookies: [],
    } as unknown as DownstreamResult);

    await expect(
      buildController(stub).resolveIncident(
        'inc_1',
        { resolutionNotes: 'closed' },
        undefined,
        OPS_REQUEST,
      ),
    ).rejects.toMatchObject({ response: problem });
  });

  it('maps an unconfigured route to 503 naming the env var', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'trust-safety',
    } as unknown as DownstreamResult);

    await expect(
      buildController(stub).getCaseByIncident('inc_1', OPS_REQUEST),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

const JURISDICTION_BODY = {
  jurisdiction: {
    stateCode: 'NY',
    agencyName: null,
    reportingPhone: null,
    reportingUrl: null,
    statutoryDeadlineHours: null,
    platformRole: 'undetermined' as const,
    statuteCitation: null,
    verified: false,
    verifiedAt: null,
    verifiedByUserId: null,
    notes: null,
  },
};

describe('AdminTrustSafetyMandatedReporterProxyController — jurisdiction kit (TS-303c1)', () => {
  it.each([
    ['listJurisdictions'],
    ['getJurisdiction'],
    ['upsertJurisdiction'],
    ['setJurisdictionVerification'],
  ])('gates %s on trust_safety:write', (method) => {
    const required = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      (
        AdminTrustSafetyMandatedReporterProxyController.prototype as unknown as Record<
          string,
          unknown
        >
      )[method] as object,
    ) as string[];

    expect(required).toEqual(['trust_safety:write']);
  });

  it('forwards the unverified-only backlog filter as a query string', async () => {
    const stub = new StubDownstreamClient(ok({ jurisdictions: [] }));

    await buildController(stub).listJurisdictions('true', OPS_REQUEST);

    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions?unverifiedOnly=true',
    );
  });

  it('omits the filter for anything but the literal "true"', async () => {
    const stub = new StubDownstreamClient(ok({ jurisdictions: [] }));

    await buildController(stub).listJurisdictions('yes', OPS_REQUEST);

    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions',
    );
  });

  it('sends the kit edit as a PUT', async () => {
    const stub = new StubDownstreamClient(ok(JURISDICTION_BODY));

    await buildController(stub).upsertJurisdiction(
      'NY',
      { agencyName: 'Adult Protective Services' },
      'idem_2',
      OPS_REQUEST,
    );

    expect(stub.lastOptions).toMatchObject({
      path: '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/NY',
      method: 'PUT',
      idempotencyKey: 'idem_2',
    });
  });

  it('rejects an attempt to set `verified` through the edit route', async () => {
    // Attestation is a separate act with its own attribution and audit
    // action; the edit schema is `.strict()` precisely so it cannot ride
    // along on an unrelated field update.
    const stub = new StubDownstreamClient(ok(JURISDICTION_BODY));

    await expect(
      buildController(stub).upsertJurisdiction(
        'NY',
        { verified: true } as unknown as Record<string, unknown>,
        undefined,
        OPS_REQUEST,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('routes the attestation to its own verification sub-resource', async () => {
    const stub = new StubDownstreamClient(ok(JURISDICTION_BODY));

    await buildController(stub).setJurisdictionVerification(
      'NY',
      { verified: false },
      undefined,
      OPS_REQUEST,
    );

    expect(stub.lastOptions).toMatchObject({
      path: '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/NY/verification',
      method: 'POST',
    });
  });
});

describe('AdminTrustSafetyMandatedReporterProxyController.listCases (TS-303c2a)', () => {
  const QUEUE_BODY = {
    cases: [
      {
        id: 'mrc_1',
        incidentId: 'inc_1',
        stateCode: 'NY',
        status: 'screening' as const,
        openedByUserId: 'usr_ops_1',
        openedAt: OPENED_AT,
        statutoryDueAt: null,
        filedAt: null,
        filingReference: null,
        reviewerUserId: null,
        reviewedAt: null,
      },
    ],
  };

  it('forwards the queue read with the default limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(QUEUE_BODY));

    const response = await buildController(stub).listCases({}, OPS_REQUEST);

    expect(stub.lastOptions).toMatchObject({
      service: 'trust-safety',
      path: '/api/v1/admin/trust-safety/mandated-reporter/cases?limit=50',
      method: 'GET',
      traceId: 'tr_test_mrc',
    });
    expect(response.cases).toHaveLength(1);
  });

  it('forwards the status and stateCode filters', async () => {
    const stub = new StubDownstreamClient(ok({ cases: [] }));

    await buildController(stub).listCases(
      { status: 'filing_prep', stateCode: 'CA', limit: '10' },
      OPS_REQUEST,
    );

    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/trust-safety/mandated-reporter/cases?status=filing_prep&stateCode=CA&limit=10',
    );
  });

  it('re-serialises from the PARSED query — an injected extra param never reaches downstream', async () => {
    // `.strict()` on the query schema means an unknown key is a 400, so the
    // path is assembled from validated values only and cannot be smuggled
    // through.
    const stub = new StubDownstreamClient(ok({ cases: [] }));

    await expect(
      buildController(stub).listCases({ limit: '10', unverifiedOnly: 'true' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s an over-cap limit at the edge without a downstream round-trip', async () => {
    const stub = new StubDownstreamClient(ok({ cases: [] }));

    await expect(
      buildController(stub).listCases({ limit: '5000' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s an unknown status at the edge', async () => {
    const stub = new StubDownstreamClient(ok({ cases: [] }));

    await expect(
      buildController(stub).listCases({ status: 'closed' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream returns a body carrying the PHI notes fields', async () => {
    // Contract drift in the leak-prone direction: `.strict()` on the summary
    // shape turns a widened downstream projection into a 502 rather than
    // relaying a named senior's abuse narrative to a list surface.
    const leaky = {
      cases: [{ ...QUEUE_BODY.cases[0], determinationNotes: 'she flinched' }],
    };
    const stub = new StubDownstreamClient(ok(leaky));

    await expect(buildController(stub).listCases({}, OPS_REQUEST)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(QUEUE_BODY));

    await expect(
      buildController(stub).listCases({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('503s when TRUST_SAFETY_SERVICE_BASE_URL is unconfigured', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'trust-safety',
    } as unknown as DownstreamResult);

    await expect(buildController(stub).listCases({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
