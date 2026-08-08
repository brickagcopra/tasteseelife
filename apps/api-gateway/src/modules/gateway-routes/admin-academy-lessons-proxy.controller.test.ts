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

import { AdminAcademyLessonsProxyController } from './admin-academy-lessons-proxy.controller';

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
    headers: { 'x-trace-id': 'tr_acad_003' },
  } as unknown as RequestWithContext;
}

const LESSON = {
  id: 'les_1',
  moduleId: 'mod_1',
  title: 'Holding the knife',
  kind: 'video' as const,
  contentKey: null,
  bodyMarkdown: null,
  sortPosition: 0,
  durationMinutes: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { lessons: [LESSON] };
const VALID_LESSON_RESPONSE = { lesson: LESSON };

function buildController(stub: StubDownstreamClient): AdminAcademyLessonsProxyController {
  return new AdminAcademyLessonsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminAcademyLessonsProxyController.list', () => {
  it('forwards the GET to the module-scoped lessons path', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.list('mod_1', requestWithCtx());
    expect(response.lessons).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('academy');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/modules/mod_1/lessons');
    expect(stub.lastOptions?.traceId).toBe('tr_acad_003');
  });

  it('url-encodes the moduleId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list('mod/../admin', requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/modules/mod%2F..%2Fadmin/lessons');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list('mod_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient(ok({ wrong: 'shape' }));
    const controller = buildController(stub);
    await expect(controller.list('mod_1', requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('AdminAcademyLessonsProxyController.create', () => {
  it('forwards the POST + body + Idempotency-Key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LESSON_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      'mod_1',
      { title: 'Holding the knife', kind: 'video' },
      'idem-1',
      requestWithCtx(),
    );
    expect(response.lesson.id).toBe('les_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/modules/mod_1/lessons');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-1');
    expect(stub.lastOptions?.body).toMatchObject({ kind: 'video' });
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LESSON_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create('mod_1', { title: 'x', kind: 'podcast' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminAcademyLessonsProxyController.update', () => {
  it('forwards the PATCH + body + Idempotency-Key to the lesson-scoped path', async () => {
    const stub = new StubDownstreamClient(ok({ lesson: { ...LESSON, title: 'Renamed' } }));
    const controller = buildController(stub);
    const response = await controller.update(
      'les_1',
      { title: 'Renamed' },
      'idem-2',
      requestWithCtx(),
    );
    expect(response.lesson.title).toBe('Renamed');
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/lessons/les_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-2');
  });

  it('rejects an empty body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LESSON_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('les_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminAcademyLessonsProxyController.remove (204 No Content)', () => {
  it('forwards the DELETE + Idempotency-Key and returns void on a 2xx (no body parsed)', async () => {
    const stub = new StubDownstreamClient({ kind: 'ok', status: 204, body: null, setCookies: [] });
    const controller = buildController(stub);
    const response = await controller.remove('les_1', 'idem-3', requestWithCtx());
    expect(response).toBeUndefined();
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/lessons/les_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem-3');
  });

  it('does not 502 even when the downstream returns an unexpected body on the ok path', async () => {
    const stub = new StubDownstreamClient(ok({ unexpected: 'payload' }));
    const controller = buildController(stub);
    await expect(controller.remove('les_1', undefined, requestWithCtx())).resolves.toBeUndefined();
  });

  it('url-encodes the lessonId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({ kind: 'ok', status: 204, body: null, setCookies: [] });
    const controller = buildController(stub);
    await controller.remove('les/../admin', undefined, requestWithCtx());
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/academy/lessons/les%2F..%2Fadmin');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient({ kind: 'ok', status: 204, body: null, setCookies: [] });
    const controller = buildController(stub);
    await expect(
      controller.remove('les_1', undefined, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 404 verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no lesson' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(controller.remove('les_x', undefined, requestWithCtx())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('maps timeout to 504, network_error/server_error to 502, not_configured to 503', async () => {
    const timeout = buildController(new StubDownstreamClient({ kind: 'timeout' }));
    await expect(timeout.remove('les_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    const network = buildController(
      new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' }),
    );
    await expect(network.remove('les_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    const server = buildController(
      new StubDownstreamClient({ kind: 'server_error', status: 500, body: null, setCookies: [] }),
    );
    await expect(server.remove('les_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    const notConfigured = buildController(
      new StubDownstreamClient({ kind: 'not_configured', service: 'academy' }),
    );
    await expect(notConfigured.remove('les_1', undefined, requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
