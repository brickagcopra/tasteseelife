import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
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

import { AdminConciergeOnboardingsProxyController } from './admin-concierge-onboardings-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-05-26T15:00:00.000Z';

function requestWithCtx(userId = 'usr_ops'): RequestWithContext {
  return {
    requestContext: {
      userId,
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
    headers: { 'x-trace-id': 'tr_test_001' },
  } as unknown as RequestWithContext;
}

const STEP = {
  stepKey: 'welcome_kickoff_call' as const,
  sortPosition: 0,
  title: 'Welcome & 30-minute concierge kickoff call',
  description: 'Schedule and hold the white-glove kickoff call.',
  status: 'pending' as const,
  notes: null,
  completedAt: null,
  completedByUserId: null,
  updatedAt: NOW,
};

const DETAIL = {
  id: 'onb_1',
  householdId: 'hh_1',
  status: 'not_started' as const,
  kickoffScheduledAt: null,
  notes: null,
  startedByUserId: 'usr_ops',
  stepsTotal: 6,
  stepsCompleted: 0,
  completedAt: null,
  canceledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  steps: [STEP],
};

const SUMMARY = {
  id: 'onb_1',
  householdId: 'hh_1',
  status: 'in_progress' as const,
  kickoffScheduledAt: null,
  notes: null,
  startedByUserId: 'usr_ops',
  stepsTotal: 6,
  stepsCompleted: 2,
  completedAt: null,
  canceledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { onboardings: [SUMMARY] };
const VALID_DETAIL_RESPONSE = { onboarding: DETAIL };

function buildController(stub: StubDownstreamClient): AdminConciergeOnboardingsProxyController {
  return new AdminConciergeOnboardingsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminConciergeOnboardingsProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list(
      { householdId: 'hh_9', status: 'in_progress', limit: '25' },
      requestWithCtx(),
    );

    expect(response.onboardings).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/concierge/onboardings?');
    expect(stub.lastOptions?.path).toContain('householdId=hh_9');
    expect(stub.lastOptions?.path).toContain('status=in_progress');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await buildController(stub).list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await expect(
      buildController(stub).list({ status: 'nope' }, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    await expect(
      buildController(stub).list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    await expect(buildController(stub).list({}, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    await expect(buildController(stub).list({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminConciergeOnboardingsProxyController.create', () => {
  it('re-validates the body, forwards the POST + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.create({ householdId: 'hh_9' }, 'idem-1', requestWithCtx());

    expect(response.onboarding.id).toBe('onb_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/onboardings');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect((stub.lastOptions?.body as { householdId: string }).householdId).toBe('hh_9');
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).create({ notAField: 1 }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { title: 'Conflict' },
      setCookies: [],
    });
    await expect(
      buildController(stub).create({ householdId: 'hh_1' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminConciergeOnboardingsProxyController.get', () => {
  it('URL-encodes the id and forwards the GET', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const response = await buildController(stub).get('onb/../x', requestWithCtx());
    expect(response.onboarding.id).toBe('onb_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/onboardings/onb%2F..%2Fx');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { title: 'Not Found' },
      setCookies: [],
    });
    await expect(buildController(stub).get('onb_x', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    await expect(buildController(stub).get('onb_1', requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });
});

describe('AdminConciergeOnboardingsProxyController.update', () => {
  it('re-validates the body, forwards the PATCH + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const response = await buildController(stub).update(
      'onb_1',
      { status: 'canceled' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.onboarding.id).toBe('onb_1');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/concierge/onboardings/onb_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).update('onb_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    await expect(
      buildController(stub).update('onb_1', { notes: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminConciergeOnboardingsProxyController.updateStep', () => {
  it('validates the step key + body, forwards the PATCH', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const response = await buildController(stub).updateStep(
      'onb_1',
      'welcome_kickoff_call',
      { status: 'completed', notes: 'done' },
      'idem-3',
      requestWithCtx(),
    );
    expect(response.onboarding.id).toBe('onb_1');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/admin/concierge/onboardings/onb_1/steps/welcome_kickoff_call',
    );
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('rejects an unknown step key with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).updateStep(
        'onb_1',
        'order_groceries',
        { status: 'completed' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a malformed step body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    await expect(
      buildController(stub).updateStep(
        'onb_1',
        'welcome_kickoff_call',
        { status: 'nope' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 verbatim (canceled onboarding)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { title: 'Conflict' },
      setCookies: [],
    });
    await expect(
      buildController(stub).updateStep(
        'onb_1',
        'welcome_kickoff_call',
        { status: 'completed' },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
