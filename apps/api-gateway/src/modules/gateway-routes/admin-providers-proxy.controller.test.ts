import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
} from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminProvidersProxyController } from './admin-providers-proxy.controller';

/**
 * Proxy tests for the admin provider directory (TS-305c-followup-1).
 *
 * The load-bearing assertions:
 *   - the downstream query string is re-serialised from the PARSED
 *     value, so an unknown filter key 400s at the edge instead of
 *     reaching service-provider or silently returning a longer list;
 *   - `includeArchived` is ALWAYS sent, never left to a downstream
 *     default — it decides whether an archived provider is visible;
 *   - a downstream body that does not match the contract is a 502, not
 *     a half-rendered directory.
 */

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const OPS_REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_ops',
    mfaVerified: true,
    roles: [
      {
        name: 'operations_manager',
        permissions: ['provider:read'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_directory' },
} as unknown as RequestWithContext;

const ROW = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Amara',
  headline: 'Slow-cooked comfort food',
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  createdAt: '2026-01-04T10:00:00.000Z',
  deletedAt: null,
};

const PAGE = { providers: [ROW], total: 187, limit: 25, offset: 0 };

function buildController(stub: StubDownstreamClient): AdminProvidersProxyController {
  return new AdminProvidersProxyController(stub as unknown as DownstreamHttpClient);
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function queryOf(stub: StubDownstreamClient): URLSearchParams {
  const path = stub.lastOptions?.path ?? '';
  return new URLSearchParams(path.slice(path.indexOf('?') + 1));
}

describe('AdminProvidersProxyController.listProviders', () => {
  it('forwards to the provider service and returns the parsed page', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    const response = await buildController(stub).listProviders({}, OPS_REQUEST);

    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path.startsWith('/api/v1/admin/providers?')).toBe(true);
    expect(response.total).toBe(187);
    expect(response.providers).toHaveLength(1);
  });

  it('always sends includeArchived, even when the caller omitted it', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listProviders({}, OPS_REQUEST);

    expect(queryOf(stub).get('includeArchived')).toBe('false');
  });

  it('forwards includeArchived=true when asked', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listProviders({ includeArchived: 'true' }, OPS_REQUEST);

    expect(queryOf(stub).get('includeArchived')).toBe('true');
  });

  it('forwards the defaulted limit and offset explicitly', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listProviders({}, OPS_REQUEST);

    const search = queryOf(stub);
    expect(search.get('limit')).toBe('25');
    expect(search.get('offset')).toBe('0');
  });

  it('forwards the trimmed q and the exact-match filters', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listProviders(
      { q: '  amara ', status: 'suspended', tier: 'elite' },
      OPS_REQUEST,
    );

    const search = queryOf(stub);
    expect(search.get('q')).toBe('amara');
    expect(search.get('status')).toBe('suspended');
    expect(search.get('tier')).toBe('elite');
  });

  it('omits filters the caller did not send rather than sending empty values', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await buildController(stub).listProviders({}, OPS_REQUEST);

    const search = queryOf(stub);
    expect(search.has('q')).toBe(false);
    expect(search.has('status')).toBe(false);
    expect(search.has('tier')).toBe(false);
  });

  it('400s on an unknown filter key without calling downstream', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listProviders({ statuss: 'active' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('400s on an out-of-range limit without calling downstream', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listProviders({ limit: '5000' }, OPS_REQUEST),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('502s when the downstream body does not conform to the contract', async () => {
    const stub = new StubDownstreamClient(ok({ providers: [ROW] }));

    await expect(buildController(stub).listProviders({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('502s when the downstream row carries a field the contract excludes', async () => {
    // A `bio` reaching the wire is a leak, not a tolerable extra field.
    const stub = new StubDownstreamClient(
      ok({ ...PAGE, providers: [{ ...ROW, bio: 'Twenty years of...' }] }),
    );

    await expect(buildController(stub).listProviders({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('passes a downstream client error through verbatim', async () => {
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Missing permission.' },
      setCookies: [],
    } as unknown as DownstreamResult);

    await expect(buildController(stub).listProviders({}, OPS_REQUEST)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('maps a downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' } as unknown as DownstreamResult);

    await expect(buildController(stub).listProviders({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('maps an unconfigured provider route to 503 naming the env var', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'provider',
    } as unknown as DownstreamResult);

    await expect(buildController(stub).listProviders({}, OPS_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('401s when the request carries no verified context', async () => {
    const stub = new StubDownstreamClient(ok(PAGE));

    await expect(
      buildController(stub).listProviders({}, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is gated on provider:read behind the token, permission, and rate-limit guards', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminProvidersProxyController.prototype.listProviders,
    ) as unknown;
    expect(permissions).toEqual(['provider:read']);

    const guards = Reflect.getMetadata('__guards__', AdminProvidersProxyController) as unknown[];
    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });
});
