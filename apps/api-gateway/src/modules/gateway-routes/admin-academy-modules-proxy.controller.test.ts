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

import { AdminAcademyModulesProxyController } from './admin-academy-modules-proxy.controller';

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
    headers: { 'x-trace-id': 'tr_acad_002' },
  } as unknown as RequestWithContext;
}

const MODULE = {
  id: 'mod_1',
  courseId: 'crs_1',
  title: 'Foundations',
  description: null,
  sortPosition: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { modules: [MODULE] };
const VALID_MODULE_RESPONSE = { module: MODULE };
const VALID_DELETE_RESPONSE = { deletedModuleId: 'mod_1', deletedLessonCount: 3 };

function buildController(stub: StubDownstreamClient): AdminAcademyModulesProxyController {
  return new AdminAcademyModulesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAcademyModulesProxyController.list', () => {
  it('forwards the GET to the course-scoped modules path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.list('crs_1', requestWithCtx());
    expect(response.modules).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('academy');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1/modules');
    expect(stub.lastOptions?.traceId).toBe('tr_acad_002');
  });

  it('url-encodes the courseId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list('crs/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs%2F..%2Fadmin/modules');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list('crs_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.list('crs_1', requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps timeout to 504 and not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.list('crs_1', requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'academy' }),
    );
    await expect(notConfigured.list('crs_1', requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AdminAcademyModulesProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_MODULE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      'crs_1',
      { title: 'Foundations' },
      'idem-1',
      requestWithCtx(),
    );
    expect(response.module.id).toBe('mod_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/courses/crs_1/modules');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.body).toMatchObject({ title: 'Foundations' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_MODULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create('crs_1', { title: '' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminAcademyModulesProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key to the module-scoped path', async () => {
    const stub = new StubDownstreamClient(ok({ module: { ...MODULE, title: 'Renamed' } }));
    const controller = buildController(stub);
    const response = await controller.update(
      'mod_1',
      { title: 'Renamed' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.module.title).toBe('Renamed');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/modules/mod_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_MODULE_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('mod_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a network_error to 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const controller = buildController(stub);
    await expect(
      controller.update('mod_1', { title: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminAcademyModulesProxyController.remove', () => {
  it('forwards the DELETE + Idempotency-Key and returns the cascade count', async () => {
    const stub = new StubDownstreamClient(ok(VALID_DELETE_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.remove('mod_1', 'idem-3', requestWithCtx());
    expect(response.deletedModuleId).toBe('mod_1');
    expect(response.deletedLessonCount).toBe(3);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/modules/mod_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ deletedModuleId: 'mod_1' }));
    const controller = buildController(stub);
    await expect(controller.remove('mod_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('forwards a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no module' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.remove('mod_x', undefined, requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });
});
