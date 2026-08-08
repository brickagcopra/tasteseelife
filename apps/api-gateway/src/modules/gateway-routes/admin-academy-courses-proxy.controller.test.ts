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

import { AdminAcademyCoursesProxyController } from './admin-academy-courses-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-05-27T12:00:00.000Z';

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
    headers: { 'x-trace-id': 'tr_acad_001' },
  } as unknown as RequestWithContext;
}

const COURSE = {
  id: 'crs_1',
  slug: 'knife-skills-101',
  title: 'Knife Skills 101',
  summary: 'Master the fundamentals of safe, efficient knife work.',
  description: null,
  kind: 'self_paced' as const,
  track: 'general' as const,
  status: 'draft' as const,
  level: null,
  estimatedMinutes: null,
  heroImageKey: null,
  passingScorePercent: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const COURSE_DETAIL = { ...COURSE, modules: [] };

const VALID_LIST_RESPONSE = { courses: [COURSE] };
const VALID_COURSE_RESPONSE = { course: COURSE };
const VALID_DETAIL_RESPONSE = { course: COURSE_DETAIL };
const VALID_DELETE_RESPONSE = { course: { ...COURSE, deletedAt: NOW } };

const VALID_CREATE_BODY = {
  slug: 'knife-skills-101',
  title: 'Knife Skills 101',
  summary: 'Master the fundamentals of safe, efficient knife work.',
  kind: 'self_paced',
};

function buildController(stub: StubDownstreamClient): AdminAcademyCoursesProxyController {
  return new AdminAcademyCoursesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAcademyCoursesProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);

    const response = await controller.list(
      {
        status: 'published',
        track: 'dementia_sensitive',
        kind: 'cohort_based',
        includeDeleted: 'true',
        limit: '25',
      },
      requestWithCtx(),
    );

    expect(response.courses).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('academy');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/academy/courses?');
    expect(stub.lastOptions?.path).toContain('status=published');
    expect(stub.lastOptions?.path).toContain('track=dementia_sensitive');
    expect(stub.lastOptions?.path).toContain('kind=cohort_based');
    expect(stub.lastOptions?.path).toContain('includeDeleted=true');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_acad_001');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=50');
  });

  it('rejects a malformed query with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(controller.list({ status: 'nope' }, requestWithCtx())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.list({}, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'academy' }),
    );
    await expect(notConfigured.list({}, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminAcademyCoursesProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COURSE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create({ ...VALID_CREATE_BODY }, 'idem-1', requestWithCtx());
    expect(response.course.id).toBe('crs_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    // Defaults applied by the contract before forwarding.
    expect(stub.lastOptions?.body).toMatchObject({ status: 'draft', track: 'general' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COURSE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ title: 'no slug' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects an initial status of archived with 400', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COURSE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ ...VALID_CREATE_BODY, status: 'archived' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 409 (slug collision) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'slug taken' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.create({ ...VALID_CREATE_BODY }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminAcademyCoursesProxyController.detail', () => {
  it('forwards the GET and returns the full tree', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.detail('crs_1', requestWithCtx());
    expect(response.course.modules).toEqual([]);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1');
  });

  it('url-encodes the courseId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DETAIL_RESPONSE));
    const controller = buildController(stub);
    await controller.detail('crs/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs%2F..%2Fadmin');
  });

  it('maps a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no course' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.detail('crs_x', requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('AdminAcademyCoursesProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(
      ok({ course: { ...COURSE, status: 'published' as const } }),
    );
    const controller = buildController(stub);
    const response = await controller.update(
      'crs_1',
      { status: 'published' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.course.status).toBe('published');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_COURSE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('crs_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.update('crs_1', { title: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminAcademyCoursesProxyController.remove', () => {
  it('forwards the DELETE + Idempotency-Key and returns the tombstoned course', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DELETE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.remove('crs_1', 'idem-3', requestWithCtx());
    expect(response.course.deletedAt).toBe(NOW);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('forwards a downstream 409 (course has cohorts) verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'has cohorts' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.remove('crs_1', undefined, requestWithCtx())).rejects.toMatchObject({
      status: 409,
    });
  });

  it('maps server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.remove('crs_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
