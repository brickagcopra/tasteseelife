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

import { AdminConciergeAssignmentsProxyController } from './admin-concierge-assignments-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW_ISO = '2026-06-01T09:00:00.000Z';

function requestWithCtx(userId = 'usr_admin'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [{ name: 'super_admin', permissions: [], scope: { type: 'global' } }],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_test_001' },
  } as unknown as RequestWithContext;
}

const ASSIGNMENT = {
  id: 'ca_1',
  householdId: 'hh_1',
  primaryConciergeUserId: 'user_primary',
  primaryConciergeDisplayName: 'Avery Concierge',
  backupConciergeUserId: null,
  backupConciergeDisplayName: null,
  status: 'active' as const,
  assignedByUserId: 'usr_admin',
  startedAt: NOW_ISO,
  endedAt: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_CREATE_RESPONSE = { assignment: ASSIGNMENT };
const VALID_LIST_RESPONSE = { assignments: [ASSIGNMENT] };
const VALID_END_RESPONSE = { outcome: 'ended' as const, assignmentId: 'ca_1' };

const VALID_CREATE_BODY = {
  householdId: 'hh_1',
  primaryConciergeUserId: 'user_primary',
  primaryConciergeDisplayName: 'Avery Concierge',
};

function buildController(stub: StubDownstreamClient): AdminConciergeAssignmentsProxyController {
  return new AdminConciergeAssignmentsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

// ─────────────────────────────────────────────────────────────────────
// create()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeAssignmentsProxyController.create', () => {
  it('forwards the POST and returns the created assignment', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATE_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.create(VALID_CREATE_BODY, 'idem-1', requestWithCtx());

    expect(response.assignment.id).toBe('ca_1');
    expect(stub.lastOptions?.service).toBe('concierge');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/assignments');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('stamps the actor userId into assignedByUserId, overriding a smuggled value', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATE_RESPONSE));
    const controller = buildController(stub);

    await controller.create(
      { ...VALID_CREATE_BODY, assignedByUserId: 'usr_smuggled' },
      undefined,
      requestWithCtx('usr_real_admin'),
    );

    const body = stub.lastOptions?.body as { assignedByUserId?: string };
    expect(body.assignedByUserId).toBe('usr_real_admin');
  });

  it('rejects a malformed body with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATE_RESPONSE));
    const controller = buildController(stub);

    await expect(
      controller.create({ householdId: 'hh_1' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    // The downstream is never called when validation fails.
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CREATE_RESPONSE));
    const controller = buildController(stub);

    await expect(
      controller.create(VALID_CREATE_BODY, undefined, {} as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: true }));
    const controller = buildController(stub);

    await expect(
      controller.create(VALID_CREATE_BODY, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('forwards a downstream 409 client error verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'race' },
      setCookies: [],
    });
    const controller = buildController(stub);

    await expect(
      controller.create(VALID_CREATE_BODY, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const controller = buildController(stub);

    await expect(
      controller.create(VALID_CREATE_BODY, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps not_configured to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'concierge' });
    const controller = buildController(stub);

    await expect(
      controller.create(VALID_CREATE_BODY, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// list()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeAssignmentsProxyController.list', () => {
  it('forwards the allow-listed query and returns the history', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list(
      { householdId: 'hh_1', activeOnly: 'true', limit: '10' },
      requestWithCtx(),
    );

    expect(response.assignments).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    const path = stub.lastOptions?.path ?? '';
    expect(path.startsWith('/api/v1/concierge/assignments?')).toBe(true);
    expect(path).toContain('householdId=hh_1');
    expect(path).toContain('activeOnly=true');
    expect(path).toContain('limit=10');
  });

  it('rejects an unknown query param with 400 (strict schema)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    await expect(
      controller.list({ householdId: 'hh_1', smuggled: 'x' }, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    // Validation fails before the downstream is ever called.
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a missing householdId with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// end()
// ─────────────────────────────────────────────────────────────────────

describe('AdminConciergeAssignmentsProxyController.end', () => {
  it('forwards the DELETE with the encoded id + idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_END_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.end('ca_1', 'idem-del-1', requestWithCtx());

    expect(response.outcome).toBe('ended');
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/assignments/ca_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-del-1');
  });

  it('url-encodes a slash-injection assignment id', async () => {
    const stub = new StubDownstreamClient(
      ok({ outcome: 'not_found', assignmentId: 'ca/../admin' }),
    );
    const controller = buildController(stub);

    await controller.end('ca/../admin', undefined, requestWithCtx());

    expect(stub.lastOptions?.path).toBe('/api/v1/concierge/assignments/ca%2F..%2Fadmin');
  });

  it('forwards a downstream not_found outcome verbatim (idempotent)', async () => {
    const stub = new StubDownstreamClient(ok({ outcome: 'not_found', assignmentId: 'ca_missing' }));
    const controller = buildController(stub);

    const response = await controller.end('ca_missing', undefined, requestWithCtx());

    expect(response.outcome).toBe('not_found');
  });
});
