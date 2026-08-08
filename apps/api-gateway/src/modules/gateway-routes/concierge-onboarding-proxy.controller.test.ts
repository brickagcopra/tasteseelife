import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { ConciergeOnboardingProxyController } from './concierge-onboarding-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-05-26T15:00:00.000Z';

function householdRequest(householdId = 'hh_1'): RequestWithContext {
  return {
    requestContext: {
      userId: 'usr_family',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'household', householdId },
    },
    headers: { 'x-trace-id': 'tr_fam_001' },
  } as unknown as RequestWithContext;
}

const DETAIL = {
  id: 'onb_1',
  householdId: 'hh_1',
  status: 'in_progress' as const,
  kickoffScheduledAt: NOW,
  notes: null,
  startedByUserId: 'usr_ops',
  stepsTotal: 6,
  stepsCompleted: 2,
  completedAt: null,
  canceledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  steps: [
    {
      stepKey: 'welcome_kickoff_call' as const,
      sortPosition: 0,
      title: 'Welcome & 30-minute concierge kickoff call',
      description: 'Schedule and hold the white-glove kickoff call.',
      status: 'completed' as const,
      notes: null,
      completedAt: NOW,
      completedByUserId: 'usr_concierge',
      updatedAt: NOW,
    },
  ],
};

function buildController(stub: StubDownstreamClient): ConciergeOnboardingProxyController {
  return new ConciergeOnboardingProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('ConciergeOnboardingProxyController.getMine', () => {
  it('forwards the GET /me and returns the populated onboarding', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', onboarding: DETAIL }));
    const response = await buildController(stub).getMine(householdRequest('hh_1'));
    expect(response.householdId).toBe('hh_1');
    expect(response.onboarding?.id).toBe('onb_1');
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/onboarding/me');
    expect(stub.lastOptions?.traceId).toBe('tr_fam_001');
  });

  it('returns a null onboarding when the household has none', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', onboarding: null }));
    const response = await buildController(stub).getMine(householdRequest('hh_1'));
    expect(response.onboarding).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok({ householdId: 'hh_1', onboarding: null }));
    await expect(
      buildController(stub).getMine({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 400 verbatim (non-household actor)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 400,
      body: { title: 'Bad Request' },
      setCookies: [],
    });
    await expect(buildController(stub).getMine(householdRequest())).rejects.toMatchObject({
      status: 400,
    });
  });

  it('maps a contract-violating body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    await expect(buildController(stub).getMine(householdRequest())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    await expect(buildController(stub).getMine(householdRequest())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    await expect(buildController(stub).getMine(householdRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
