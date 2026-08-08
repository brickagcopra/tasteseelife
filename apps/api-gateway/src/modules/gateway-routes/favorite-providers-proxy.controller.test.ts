import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FavoriteProvider } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { FavoriteProvidersProxyController } from './favorite-providers-proxy.controller';

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const SAMPLE_FAVORITE: FavoriteProvider = {
  id: 'fp_abc',
  ownerUserId: 'usr_abc',
  providerId: 'provider_chef',
  seniorId: 'senior_mom',
  notes: 'Loved the carbonara.',
  createdAt: '2026-05-21T12:00:00.000Z',
};

function makeController(result: DownstreamResult): {
  controller: FavoriteProvidersProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  const controller = new FavoriteProvidersProxyController(stub as unknown as DownstreamHttpClient);
  return { controller, stub };
}

describe('FavoriteProvidersProxyController.list', () => {
  it('forwards without query params when none supplied', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { favorites: [SAMPLE_FAVORITE] },
      setCookies: [],
    });
    const response = await controller.list(undefined, undefined, REQUEST_WITH_CTX);
    expect(response.favorites).toEqual([SAMPLE_FAVORITE]);
    expect(stub.lastOptions?.path).toBe('/api/v1/favorite-providers');
  });

  it('forwards providerId query param', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { favorites: [] },
      setCookies: [],
    });
    await controller.list('provider_chef', undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/favorite-providers?providerId=provider_chef');
  });

  it('forwards seniorId=null verbatim', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { favorites: [] },
      setCookies: [],
    });
    await controller.list(undefined, 'null', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/favorite-providers?seniorId=null');
  });

  it('forwards both providerId and seniorId', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { favorites: [] },
      setCookies: [],
    });
    await controller.list('provider_chef', 'senior_mom', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe(
      '/api/v1/favorite-providers?providerId=provider_chef&seniorId=senior_mom',
    );
  });

  it('throws Unauthorized when no requestContext', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { favorites: [] },
      setCookies: [],
    });
    await expect(
      controller.list(undefined, undefined, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps not_configured to 503', async () => {
    const { controller } = makeController({ kind: 'not_configured', service: 'search' });
    await expect(controller.list(undefined, undefined, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps timeout to 504', async () => {
    const { controller } = makeController({ kind: 'timeout' });
    await expect(controller.list(undefined, undefined, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });
});

describe('FavoriteProvidersProxyController.upsert', () => {
  it('forwards a valid body and returns the response', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'created', favorite: SAMPLE_FAVORITE },
      setCookies: [],
    });
    const response = await controller.upsert(
      { providerId: 'provider_chef', seniorId: 'senior_mom' },
      REQUEST_WITH_CTX,
    );
    expect(response.outcome).toBe('created');
    expect(stub.lastOptions?.method).toBe('POST');
  });

  it('rejects a missing providerId with 400', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'created', favorite: SAMPLE_FAVORITE },
      setCookies: [],
    });
    await expect(controller.upsert({}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(HttpException);
  });

  it('re-throws downstream 409 (quota) verbatim', async () => {
    const { controller } = makeController({
      kind: 'client_error',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict' },
      setCookies: [],
    });
    await expect(
      controller.upsert({ providerId: 'provider_chef' }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps server_error to 502', async () => {
    const { controller } = makeController({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    await expect(
      controller.upsert({ providerId: 'provider_chef' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('FavoriteProvidersProxyController.delete', () => {
  it('forwards the delete and returns the outcome', async () => {
    const { controller, stub } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'deleted', id: 'fp_abc' },
      setCookies: [],
    });
    const response = await controller.delete('fp_abc', REQUEST_WITH_CTX);
    expect(response).toEqual({ outcome: 'deleted', id: 'fp_abc' });
    expect(stub.lastOptions?.path).toBe('/api/v1/favorite-providers/fp_abc');
    expect(stub.lastOptions?.method).toBe('DELETE');
  });

  it('returns not_found on idempotent replay', async () => {
    const { controller } = makeController({
      kind: 'ok',
      status: 200,
      body: { outcome: 'not_found', id: 'fp_abc' },
      setCookies: [],
    });
    const response = await controller.delete('fp_abc', REQUEST_WITH_CTX);
    expect(response.outcome).toBe('not_found');
  });
});
