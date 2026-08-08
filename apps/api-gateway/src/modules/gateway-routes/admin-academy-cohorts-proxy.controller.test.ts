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

import { AdminAcademyCohortsProxyController } from './admin-academy-cohorts-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-05-27T12:00:00.000Z';
const STARTS = '2026-09-01T17:00:00.000Z';
const ENDS = '2026-10-01T17:00:00.000Z';

function requestWithCtx(userId = 'usr_admin'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'academy_admin',
          permissions: ['academy:read', 'academy:write'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_acad_004' },
  } as unknown as RequestWithContext;
}

const COHORT = {
  id: 'coh_1',
  courseId: 'crs_1',
  name: 'Fall 2026 — Tuesday evenings',
  status: 'scheduled' as const,
  startsAt: STARTS,
  endsAt: ENDS,
  capacity: 20,
  instructorUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const VALID_LIST_RESPONSE = { cohorts: [COHORT] };
const VALID_COHORT_RESPONSE = { cohort: COHORT };
const VALID_DELETE_RESPONSE = { cohort: { ...COHORT, deletedAt: NOW } };

const VALID_CREATE_BODY = {
  name: 'Fall 2026 — Tuesday evenings',
  startsAt: STARTS,
};

function buildController(stub: StubDownstreamClient): AdminAcademyCohortsProxyController {
  return new AdminAcademyCohortsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAcademyCohortsProxyController.list', () => {
  it('forwards the GET with an allow-listed query string to the course-scoped path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.list(
      'crs_1',
      { status: 'open', includeDeleted: 'true', limit: '10' },
      requestWithCtx(),
    );
    expect(response.cohorts).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('academy');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/academy/courses/crs_1/cohorts?');
    expect(stub.lastOptions?.path).toContain('status=open');
    expect(stub.lastOptions?.path).toContain('includeDeleted=true');
    expect(stub.lastOptions?.path).toContain('limit=10');
    expect(stub.lastOptions?.traceId).toBe('tr_acad_004');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list('crs_1', {}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('url-encodes the courseId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list('crs/../admin', {}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain(
      '/api/v1/admin/academy/courses/crs%2F..%2Fadmin/cohorts?',
    );
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list('crs_1', { status: 'nope' }, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list('crs_1', {}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.list('crs_1', {}, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.list('crs_1', {}, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'academy' }),
    );
    await expect(notConfigured.list('crs_1', {}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminAcademyCohortsProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COHORT_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      'crs_1',
      { ...VALID_CREATE_BODY },
      'idem-1',
      requestWithCtx(),
    );
    expect(response.cohort.id).toBe('coh_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1/cohorts');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    // Default applied by the contract before forwarding.
    expect(stub.lastOptions?.body).toMatchObject({ status: 'scheduled' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COHORT_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create('crs_1', { name: 'no start date' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects endsAt before startsAt with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COHORT_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create(
        'crs_1',
        { ...VALID_CREATE_BODY, endsAt: STARTS },
        undefined,
        requestWithCtx(),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminAcademyCohortsProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key to the cohort-scoped path', async () => {
    const stub = new StubDownstreamClient(ok({ cohort: { ...COHORT, status: 'open' as const } }));
    const controller = buildController(stub);
    const response = await controller.update(
      'coh_1',
      { status: 'open' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.cohort.status).toBe('open');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/cohorts/coh_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COHORT_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('coh_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 (terminal cohort) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'terminal' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.update('coh_1', { status: 'open' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminAcademyCohortsProxyController.remove', () => {
  it('forwards the DELETE + Idempotency-Key and returns the tombstoned cohort', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DELETE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.remove('coh_1', 'idem-3', requestWithCtx());
    expect(response.cohort.deletedAt).toBe(NOW);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/cohorts/coh_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(controller.remove('coh_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
