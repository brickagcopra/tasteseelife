import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  AdCampaignDetail,
  AdCampaignRecord,
  AdCreativeRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  CampaignsService,
  type CreateCampaignOutcome,
  type GetCampaignOutcome,
  type UpdateCampaignOutcome,
  type UpdateCreativeStatusOutcome,
} from '../services/campaigns.service';
import { CampaignsController } from './campaigns.controller';

const TS = '2026-06-13T00:00:00.000Z';

function record(overrides: Partial<AdCampaignRecord> = {}): AdCampaignRecord {
  return {
    id: 'camp_1',
    name: 'Spring upsell',
    advertiserKind: 'internal',
    advertiserId: null,
    status: 'draft',
    budgetMinor: 500000,
    currency: 'USD',
    startAt: null,
    endAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function creative(overrides: Partial<AdCreativeRecord> = {}): AdCreativeRecord {
  return {
    id: 'crea_1',
    campaignId: 'camp_1',
    kind: 'banner',
    assetKeys: [],
    headline: 'Hi',
    body: null,
    ctaUrl: null,
    status: 'pending_review',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listCampaigns: ReturnType<typeof vi.fn>;
  createCampaign: ReturnType<typeof vi.fn>;
  getCampaignDetail: ReturnType<typeof vi.fn>;
  updateCampaign: ReturnType<typeof vi.fn>;
  updateCreativeStatus: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: CampaignsController;
  service: FakeService;
} {
  const detail: AdCampaignDetail = { ...record(), creatives: [], targetingRules: [] };
  const service: FakeService = {
    listCampaigns: vi.fn(async (): Promise<readonly AdCampaignRecord[]> => [record()]),
    createCampaign: vi.fn(
      async (): Promise<CreateCampaignOutcome> => ({ ok: true, campaign: record() }),
    ),
    getCampaignDetail: vi.fn(
      async (): Promise<GetCampaignOutcome> => ({ ok: true, campaign: detail }),
    ),
    updateCampaign: vi.fn(
      async (): Promise<UpdateCampaignOutcome> => ({
        ok: true,
        campaign: record({ status: 'active' }),
      }),
    ),
    updateCreativeStatus: vi.fn(
      async (): Promise<UpdateCreativeStatusOutcome> => ({ ok: true, creative: creative() }),
    ),
    ...overrides,
  };
  const controller = new CampaignsController(service as unknown as CampaignsService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req_test' },
  } as unknown as RequestWithContext;
}

describe('CampaignsController.list', () => {
  it('returns the matching campaigns', async () => {
    const { controller, service } = build();
    const response = await controller.list({ limit: 50 });
    expect(response.campaigns).toHaveLength(1);
    expect(service.listCampaigns).toHaveBeenCalledWith({
      status: undefined,
      advertiserKind: undefined,
      limit: 50,
    });
  });
});

describe('CampaignsController.create', () => {
  const body = {
    name: 'Spring',
    advertiserKind: 'internal' as const,
    advertiserId: null,
    currency: 'USD',
    status: 'draft' as const,
  };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.campaign.id).toBe('camp_1');
    expect(service.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42', userAgent: 'jest' }),
      }),
    );
  });

  it('maps an unsupported currency to 422', async () => {
    const { controller } = build({
      createCampaign: vi.fn(async () => ({ ok: false, reason: 'unsupported_currency' })),
    });
    await expect(
      controller.create({ ...body, currency: 'EUR' }, adminRequest()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CampaignsController.detail', () => {
  it('returns the campaign detail', async () => {
    const { controller } = build();
    const response = await controller.detail('camp_1');
    expect(response.campaign.id).toBe('camp_1');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getCampaignDetail: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.detail('camp_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CampaignsController.update', () => {
  it('applies the update', async () => {
    const { controller } = build();
    const response = await controller.update('camp_1', { status: 'active' }, adminRequest());
    expect(response.campaign.status).toBe('active');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      updateCampaign: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(
      controller.update('camp_x', { status: 'active' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an invalid transition to 409', async () => {
    const { controller } = build({
      updateCampaign: vi.fn(async () => ({
        ok: false,
        reason: 'invalid_transition',
        from: 'completed',
        to: 'active',
      })),
    });
    await expect(
      controller.update('camp_1', { status: 'active' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    'unsupported_currency',
    'advertiser_required',
    'advertiser_not_allowed',
    'invalid_window',
  ] as const)('maps %s to 422', async (reason) => {
    const { controller } = build({
      updateCampaign: vi.fn(async () => ({ ok: false, reason })),
    });
    await expect(controller.update('camp_1', { name: 'x' }, adminRequest())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('CampaignsController.updateCreativeStatus', () => {
  it('advances the creative', async () => {
    const { controller, service } = build();
    const response = await controller.updateCreativeStatus(
      'camp_1',
      'crea_1',
      { status: 'approved' },
      adminRequest('admin_7'),
    );
    expect(response.creative.id).toBe('crea_1');
    expect(service.updateCreativeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'camp_1',
        creativeId: 'crea_1',
        status: 'approved',
        actorUserId: 'admin_7',
        audit: expect.objectContaining({ actorUserId: 'admin_7' }),
      }),
    );
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      updateCreativeStatus: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(
      controller.updateCreativeStatus('camp_1', 'crea_x', { status: 'approved' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps an invalid transition to 409', async () => {
    const { controller } = build({
      updateCreativeStatus: vi.fn(async () => ({
        ok: false,
        reason: 'invalid_transition',
        from: 'draft',
        to: 'approved',
      })),
    });
    await expect(
      controller.updateCreativeStatus('camp_1', 'crea_1', { status: 'approved' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
