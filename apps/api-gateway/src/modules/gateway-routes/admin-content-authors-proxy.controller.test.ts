import {
  BadGatewayException,
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

import { AdminContentAuthorsProxyController } from './admin-content-authors-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const NOW = '2026-06-30T12:00:00.000Z';

function requestWithCtx(userId = 'usr_editor'): RequestWithContext {
  return {
    requestContext: {
      userId,
      mfaVerified: true,
      roles: [
        {
          name: 'content_editor',
          permissions: ['content:read', 'content:edit'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    headers: { 'x-trace-id': 'tr_auth_001', 'idempotency-key': 'idem_001' },
  } as unknown as RequestWithContext;
}

const AUTHOR = {
  id: 'author_1',
  userId: 'usr_writer',
  displayName: 'Ada Writer',
  bio: null,
  photoAssetKey: null,
  socialLinks: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { authors: [AUTHOR] };
const VALID_AUTHOR_RESPONSE = { author: AUTHOR };

function buildController(stub: StubDownstreamClient): AdminContentAuthorsProxyController {
  return new AdminContentAuthorsProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminContentAuthorsProxyController.list', () => {
  it('forwards the GET with an allow-listed limit', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.list({ limit: '25' }, requestWithCtx());
    expect(response.authors).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('content');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/content/authors?');
    expect(stub.lastOptions?.path).toContain('limit=25');
    expect(stub.lastOptions?.traceId).toBe('tr_auth_001');
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
    await expect(controller.list({ limit: '99999' }, requestWithCtx())).rejects.toBeInstanceOf(
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

  it('throws 502 when the downstream body violates the contract', async () => {
    const stub = new StubDownstreamClient(ok({ authors: [{ bogus: true }] }));
    const controller = buildController(stub);
    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminContentAuthorsProxyController.create', () => {
  it('forwards the POST with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_AUTHOR_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      { userId: 'usr_writer', displayName: 'Ada Writer' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.author.id).toBe('author_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/authors');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects a malformed body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_AUTHOR_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ displayName: '' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentAuthorsProxyController.detail / update', () => {
  it('forwards the detail GET', async () => {
    const stub = new StubDownstreamClient(ok(VALID_AUTHOR_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.detail('author_1', requestWithCtx());
    expect(response.author.id).toBe('author_1');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/authors/author_1');
  });

  it('forwards the PATCH update with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_AUTHOR_RESPONSE));
    const controller = buildController(stub);
    await controller.update('author_1', { displayName: 'Renamed' }, 'idem_up', requestWithCtx());
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/authors/author_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_up');
  });

  it('rejects a malformed update body with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_AUTHOR_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.update('author_1', {}, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a not_configured downstream to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'content' });
    const controller = buildController(stub);
    await expect(controller.detail('author_1', requestWithCtx())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
