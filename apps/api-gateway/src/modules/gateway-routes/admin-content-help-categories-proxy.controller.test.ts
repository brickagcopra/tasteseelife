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

import { AdminContentHelpCategoriesProxyController } from './admin-content-help-categories-proxy.controller';

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
    headers: { 'x-trace-id': 'tr_hc_001', 'idempotency-key': 'idem_001' },
  } as unknown as RequestWithContext;
}

const CATEGORY = {
  id: 'cat_1',
  slug: 'getting-started',
  name: 'Getting started',
  parentId: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_LIST_RESPONSE = { categories: [CATEGORY] };
const VALID_CATEGORY_RESPONSE = { category: CATEGORY };

function buildController(stub: StubDownstreamClient): AdminContentHelpCategoriesProxyController {
  return new AdminContentHelpCategoriesProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

describe('AdminContentHelpCategoriesProxyController.list', () => {
  it('forwards the GET with an allow-listed query string', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.list(
      { parentId: 'cat_root', limit: '100' },
      requestWithCtx(),
    );
    expect(response.categories).toHaveLength(1);
    expect(stub.lastOptions?.service).toBe('content');
    expect(stub.lastOptions?.path).toContain('/api/v1/admin/content/help-categories?');
    expect(stub.lastOptions?.path).toContain('limit=100');
    expect(stub.lastOptions?.path).toContain('parentId=cat_root');
  });

  it('defaults the limit when no query is supplied', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await controller.list({}, requestWithCtx());
    expect(stub.lastOptions?.path).toContain('limit=500');
  });

  it('throws 401 when no request context is attached', async () => {
    const stub = new StubDownstreamClient(ok(VALID_LIST_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.list({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 502 when the downstream body violates the contract', async () => {
    const stub = new StubDownstreamClient(ok({ categories: [{ bogus: true }] }));
    const controller = buildController(stub);
    await expect(controller.list({}, requestWithCtx())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('AdminContentHelpCategoriesProxyController.create', () => {
  it('forwards the POST with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CATEGORY_RESPONSE));
    const controller = buildController(stub);
    const response = await controller.create(
      { slug: 'getting-started', name: 'Getting started' },
      'idem_001',
      requestWithCtx(),
    );
    expect(response.category.id).toBe('cat_1');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/help-categories');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('rejects a bad slug with 400 (downstream not called)', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CATEGORY_RESPONSE));
    const controller = buildController(stub);
    await expect(
      controller.create({ slug: 'Bad Slug', name: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });
});

describe('AdminContentHelpCategoriesProxyController.update', () => {
  it('forwards the PATCH with the idempotency key', async () => {
    const stub = new StubDownstreamClient(ok(VALID_CATEGORY_RESPONSE));
    const controller = buildController(stub);
    await controller.update('cat_1', { name: 'Renamed' }, 'idem_001', requestWithCtx());
    expect(stub.lastOptions?.method).toBe('PATCH');
    expect(stub.lastOptions?.path).toBe('/api/v1/admin/content/help-categories/cat_1');
    expect(stub.lastOptions?.idempotencyKey).toBe('idem_001');
  });

  it('passes a 409 cycle-rejected through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'cycle' },
      setCookies: [],
    });
    const controller = buildController(stub);
    await expect(
      controller.update('cat_1', { parentId: 'cat_child' }, undefined, requestWithCtx()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a not_configured downstream to 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'content' });
    const controller = buildController(stub);
    await expect(
      controller.update('cat_1', { name: 'x' }, undefined, requestWithCtx()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
