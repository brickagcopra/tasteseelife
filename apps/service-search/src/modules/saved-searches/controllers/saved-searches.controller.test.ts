import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SAVED_SEARCHES_MAX_PER_OWNER,
  type CreateSavedSearchRequest,
  type SavedSearch,
  type SearchProvidersRequest,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { OwnerQuotaExceededError, SavedSearchesService } from '../services/saved-searches.service';

import { SavedSearchesController } from './saved-searches.controller';

const sampleQuery: SearchProvidersRequest = {
  query: 'italian',
  sort: 'relevance',
  limit: 20,
};

const sampleSaved: SavedSearch = {
  id: 'ss_abc',
  ownerUserId: 'user_payer',
  seniorId: 'senior_mom',
  name: 'Italian chefs',
  query: sampleQuery,
  lastRunAt: null,
  createdAt: '2026-05-21T12:00:00.000Z',
  updatedAt: '2026-05-21T12:00:00.000Z',
};

function makeRequest(userId: string | undefined): RequestWithContext {
  if (userId === undefined) {
    return { headers: {} } as unknown as RequestWithContext;
  }
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
  create = vi.fn();
  update = vi.fn();
  run = vi.fn();
  delete = vi.fn();
}

function makeController(svc: FakeService): SavedSearchesController {
  return new SavedSearchesController(svc as unknown as SavedSearchesService);
}

describe('SavedSearchesController.list', () => {
  it('returns the service list', async () => {
    const svc = new FakeService();
    svc.listForOwner.mockResolvedValue([sampleSaved]);
    const controller = makeController(svc);
    const response = await controller.list(makeRequest('user_payer'));
    expect(response.savedSearches).toEqual([sampleSaved]);
    expect(svc.listForOwner).toHaveBeenCalledWith('user_payer');
  });

  it('rejects when the request context is missing', async () => {
    const controller = makeController(new FakeService());
    await expect(controller.list(makeRequest(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('SavedSearchesController.get (TS-215-followup-1)', () => {
  it('returns the row wrapped in the GetSavedSearchResponse shape', async () => {
    const svc = new FakeService();
    svc.findByIdForOwner.mockResolvedValue(sampleSaved);
    const controller = makeController(svc);
    const response = await controller.get(makeRequest('user_payer'), sampleSaved.id);
    expect(response.savedSearch).toEqual(sampleSaved);
    expect(svc.findByIdForOwner).toHaveBeenCalledWith('user_payer', sampleSaved.id);
  });

  it('throws NotFoundException when the service returns null (missing or non-owner)', async () => {
    const svc = new FakeService();
    svc.findByIdForOwner.mockResolvedValue(null);
    const controller = makeController(svc);
    await expect(controller.get(makeRequest('user_payer'), 'ss_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects when the request context is missing', async () => {
    const svc = new FakeService();
    const controller = makeController(svc);
    await expect(controller.get(makeRequest(undefined), sampleSaved.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.findByIdForOwner).not.toHaveBeenCalled();
  });
});

describe('SavedSearchesController.create', () => {
  const body: CreateSavedSearchRequest = {
    name: 'Italian chefs',
    seniorId: 'senior_mom',
    query: sampleQuery,
  };

  it('persists the saved search and returns it', async () => {
    const svc = new FakeService();
    svc.create.mockResolvedValue(sampleSaved);
    const controller = makeController(svc);
    const response = await controller.create(makeRequest('user_payer'), body);
    expect(response).toEqual(sampleSaved);
    expect(svc.create).toHaveBeenCalledWith('user_payer', body);
  });

  it('maps OwnerQuotaExceededError to ConflictException', async () => {
    const svc = new FakeService();
    svc.create.mockRejectedValue(
      new OwnerQuotaExceededError(SAVED_SEARCHES_MAX_PER_OWNER, SAVED_SEARCHES_MAX_PER_OWNER),
    );
    const controller = makeController(svc);
    await expect(controller.create(makeRequest('user_payer'), body)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('SavedSearchesController.update', () => {
  it('returns the updated row', async () => {
    const svc = new FakeService();
    svc.update.mockResolvedValue({ ...sampleSaved, name: 'Renamed' });
    const controller = makeController(svc);
    const response = await controller.update(makeRequest('user_payer'), sampleSaved.id, {
      name: 'Renamed',
    });
    expect(response.name).toBe('Renamed');
  });

  it('rejects an empty patch body with 422', async () => {
    const svc = new FakeService();
    const controller = makeController(svc);
    await expect(
      controller.update(makeRequest('user_payer'), sampleSaved.id, {}),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when service returns null', async () => {
    const svc = new FakeService();
    svc.update.mockResolvedValue(null);
    const controller = makeController(svc);
    await expect(
      controller.update(makeRequest('user_payer'), 'ss_missing', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SavedSearchesController.run', () => {
  it('returns the refreshed row wrapped in the response shape', async () => {
    const svc = new FakeService();
    const ran = { ...sampleSaved, lastRunAt: '2026-05-21T13:00:00.000Z' };
    svc.run.mockResolvedValue(ran);
    const controller = makeController(svc);
    const response = await controller.run(makeRequest('user_payer'), sampleSaved.id);
    expect(response.savedSearch).toEqual(ran);
  });

  it('throws NotFoundException when service returns null', async () => {
    const svc = new FakeService();
    svc.run.mockResolvedValue(null);
    const controller = makeController(svc);
    await expect(controller.run(makeRequest('user_payer'), 'ss_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SavedSearchesController.delete', () => {
  it('returns the deleted outcome', async () => {
    const svc = new FakeService();
    svc.delete.mockResolvedValue('deleted');
    const controller = makeController(svc);
    const response = await controller.delete(makeRequest('user_payer'), sampleSaved.id);
    expect(response).toEqual({ outcome: 'deleted', id: sampleSaved.id });
  });

  it('returns the not_found outcome on replay (idempotent)', async () => {
    const svc = new FakeService();
    svc.delete.mockResolvedValue('not_found');
    const controller = makeController(svc);
    const response = await controller.delete(makeRequest('user_payer'), sampleSaved.id);
    expect(response).toEqual({ outcome: 'not_found', id: sampleSaved.id });
  });
});
