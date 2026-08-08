import { ConflictException, UnauthorizedException } from '@nestjs/common';
import {
  FAVORITE_PROVIDERS_MAX_PER_OWNER,
  type CreateFavoriteProviderRequest,
  type FavoriteProvider,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  FavoriteProvidersService,
  OwnerQuotaExceededError,
} from '../services/favorite-providers.service';

import { FavoriteProvidersController } from './favorite-providers.controller';

const sampleFavorite: FavoriteProvider = {
  id: 'fp_abc',
  ownerUserId: 'user_payer',
  providerId: 'provider_chef',
  seniorId: 'senior_mom',
  notes: 'Loved the carbonara.',
  createdAt: '2026-05-21T12:00:00.000Z',
};

function makeRequest(userId: string | undefined): RequestWithContext {
  if (userId === undefined) return { headers: {} } as unknown as RequestWithContext;
  return {
    headers: {},
    requestContext: {
      userId,
      mfaVerified: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
  } as unknown as RequestWithContext;
}

class FakeService {
  listForOwner = vi.fn();
  findByIdForOwner = vi.fn();
  upsert = vi.fn();
  delete = vi.fn();
}

function makeController(svc: FakeService): FavoriteProvidersController {
  return new FavoriteProvidersController(svc as unknown as FavoriteProvidersService);
}

describe('FavoriteProvidersController.list', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the unfiltered list when no query params supplied', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([sampleFavorite]);
    const controller = makeController(svc);
    const response = await controller.list(makeRequest('user_payer'));
    expect(response.favorites).toEqual([sampleFavorite]);
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer', {});
  });

  it('passes providerId filter through', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([sampleFavorite]);
    const controller = makeController(svc);
    await controller.list(makeRequest('user_payer'), 'provider_chef');
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer', {
      providerId: 'provider_chef',
    });
  });

  it('interprets seniorId=null as the no-senior filter', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([]);
    const controller = makeController(svc);
    await controller.list(makeRequest('user_payer'), undefined, 'null');
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer', { seniorId: null });
  });

  it('interprets seniorId="" as the no-senior filter', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([]);
    const controller = makeController(svc);
    await controller.list(makeRequest('user_payer'), undefined, '');
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer', { seniorId: null });
  });

  it('passes a specific seniorId through verbatim', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([]);
    const controller = makeController(svc);
    await controller.list(makeRequest('user_payer'), undefined, 'senior_mom');
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer', { seniorId: 'senior_mom' });
  });

  it('rejects an over-long providerId via the Zod parser', async () => {
    const svc = new FakeService();
    const controller = makeController(svc);
    const tooLong = 'x'.repeat(200);
    await expect(controller.list(makeRequest('user_payer'), tooLong)).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('rejects when the request context is missing', async () => {
    const controller = makeController(new FakeService());
    await expect(controller.list(makeRequest(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('FavoriteProvidersController.upsert', () => {
  const body: CreateFavoriteProviderRequest = {
    providerId: 'provider_chef',
    seniorId: 'senior_mom',
    notes: 'Loved the carbonara.',
  };

  it('passes through the service response on a created outcome', async () => {
    const svc = new FakeService();
    svc.upsert.mockResolvedValue({ outcome: 'created', favorite: sampleFavorite });
    const controller = makeController(svc);
    const response = await controller.upsert(makeRequest('user_payer'), body);
    expect(response).toEqual({ outcome: 'created', favorite: sampleFavorite });
    expect(svc.upsert).toHaveBeenCalledWith('user_payer', body);
  });

  it('passes through the service response on an unchanged outcome', async () => {
    const svc = new FakeService();
    svc.upsert.mockResolvedValue({ outcome: 'unchanged', favorite: sampleFavorite });
    const controller = makeController(svc);
    const response = await controller.upsert(makeRequest('user_payer'), body);
    expect(response.outcome).toBe('unchanged');
  });

  it('maps OwnerQuotaExceededError to ConflictException', async () => {
    const svc = new FakeService();
    svc.upsert.mockRejectedValue(
      new OwnerQuotaExceededError(
        FAVORITE_PROVIDERS_MAX_PER_OWNER,
        FAVORITE_PROVIDERS_MAX_PER_OWNER,
      ),
    );
    const controller = makeController(svc);
    await expect(controller.upsert(makeRequest('user_payer'), body)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('FavoriteProvidersController.delete', () => {
  it('returns the deleted outcome', async () => {
    const svc = new FakeService();
    svc.delete.mockResolvedValue('deleted');
    const controller = makeController(svc);
    const response = await controller.delete(makeRequest('user_payer'), sampleFavorite.id);
    expect(response).toEqual({ outcome: 'deleted', id: sampleFavorite.id });
  });

  it('returns the not_found outcome on replay', async () => {
    const svc = new FakeService();
    svc.delete.mockResolvedValue('not_found');
    const controller = makeController(svc);
    const response = await controller.delete(makeRequest('user_payer'), sampleFavorite.id);
    expect(response).toEqual({ outcome: 'not_found', id: sampleFavorite.id });
  });
});
