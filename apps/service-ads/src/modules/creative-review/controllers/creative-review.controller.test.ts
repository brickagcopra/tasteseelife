import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  AdAccessibilityReport,
  AdCreativeReviewItem,
  AdCreativeReviewRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  CreativeReviewService,
  type GetReviewDetailOutcome,
  type ReviewCreativeOutcome,
  type UpdateAccessibilityOutcome,
} from '../services/creative-review.service';
import { CreativeReviewController } from './creative-review.controller';

const TS = '2026-06-15T00:00:00.000Z';

const PASSING_REPORT: AdAccessibilityReport = {
  passed: true,
  checks: [
    { id: 'alt_text_present', status: 'pass', detail: 'ok', contrastRatio: null },
    { id: 'contrast_ratio', status: 'pass', detail: 'ok', contrastRatio: 21 },
    { id: 'motion_safe', status: 'pass', detail: 'ok', contrastRatio: null },
    { id: 'disclosure_acknowledged', status: 'pass', detail: 'ok', contrastRatio: null },
  ],
};

const FAILING_REPORT: AdAccessibilityReport = {
  passed: false,
  checks: [
    { id: 'alt_text_present', status: 'fail', detail: 'missing', contrastRatio: null },
    { id: 'contrast_ratio', status: 'fail', detail: 'undeclared', contrastRatio: null },
    { id: 'motion_safe', status: 'pass', detail: 'ok', contrastRatio: null },
    {
      id: 'disclosure_acknowledged',
      status: 'fail',
      detail: 'not acknowledged',
      contrastRatio: null,
    },
  ],
};

function item(overrides: Partial<AdCreativeReviewItem> = {}): AdCreativeReviewItem {
  return {
    creative: {
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      assetKeys: [],
      headline: 'A warm meal',
      body: null,
      ctaUrl: null,
      status: 'pending_review',
      createdAt: TS,
      updatedAt: TS,
    },
    accessibilityMetadata: {
      altText: 'A warm meal',
      textColor: '#000000',
      backgroundColor: '#ffffff',
      motionSafe: true,
      disclosureAcknowledged: true,
    },
    accessibility: PASSING_REPORT,
    campaign: { id: 'camp_1', name: 'Spring', advertiserKind: 'partner' },
    ...overrides,
  };
}

function reviewRecord(overrides: Partial<AdCreativeReviewRecord> = {}): AdCreativeReviewRecord {
  return {
    id: 'rev_1',
    creativeId: 'c_1',
    decision: 'approved',
    reviewerUserId: 'user_admin',
    notes: null,
    accessibilityPassed: true,
    overrodeAccessibility: false,
    accessibility: PASSING_REPORT,
    createdAt: TS,
    ...overrides,
  };
}

interface FakeService {
  getReviewQueue: ReturnType<typeof vi.fn>;
  getReviewDetail: ReturnType<typeof vi.fn>;
  updateAccessibility: ReturnType<typeof vi.fn>;
  reviewCreative: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: CreativeReviewController;
  service: FakeService;
} {
  const service: FakeService = {
    getReviewQueue: vi.fn(async (): Promise<readonly AdCreativeReviewItem[]> => [item()]),
    getReviewDetail: vi.fn(
      async (): Promise<GetReviewDetailOutcome> => ({
        ok: true,
        item: item(),
        reviews: [reviewRecord()],
      }),
    ),
    updateAccessibility: vi.fn(
      async (): Promise<UpdateAccessibilityOutcome> => ({ ok: true, item: item() }),
    ),
    reviewCreative: vi.fn(
      async (): Promise<ReviewCreativeOutcome> => ({
        ok: true,
        item: item({ creative: { ...item().creative, status: 'approved' } }),
        review: reviewRecord(),
      }),
    ),
    ...overrides,
  };
  const controller = new CreativeReviewController(service as unknown as CreativeReviewService);
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
    headers: { 'user-agent': 'jest' },
  } as unknown as RequestWithContext;
}

describe('CreativeReviewController.queue', () => {
  it('returns the pending-review queue', async () => {
    const { controller } = build();
    const response = await controller.queue({ limit: 50 });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.creative.id).toBe('c_1');
    expect(response.items[0]?.accessibility.passed).toBe(true);
  });
});

describe('CreativeReviewController.detail', () => {
  it('returns the review detail with history', async () => {
    const { controller } = build();
    const response = await controller.detail('c_1');
    expect(response.item.creative.id).toBe('c_1');
    expect(response.reviews).toHaveLength(1);
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getReviewDetail: vi.fn(
        async (): Promise<GetReviewDetailOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(controller.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CreativeReviewController.updateAccessibility', () => {
  it('applies metadata and returns review:null', async () => {
    const { controller, service } = build();
    const response = await controller.updateAccessibility('c_1', { altText: 'x' }, adminRequest());
    expect(response.review).toBeNull();
    expect(response.item.creative.id).toBe('c_1');
    expect(service.updateAccessibility).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: 'c_1', actorUserId: 'user_admin', altText: 'x' }),
    );
  });

  it('401s without a request context', async () => {
    const { controller } = build();
    await expect(
      controller.updateAccessibility('c_1', { altText: 'x' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      updateAccessibility: vi.fn(
        async (): Promise<UpdateAccessibilityOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.updateAccessibility('missing', { altText: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CreativeReviewController.review', () => {
  it('approves and attributes the reviewer from the token', async () => {
    const { controller, service } = build();
    const response = await controller.review(
      'c_1',
      { action: 'approve', acknowledgeAccessibilityFailures: false },
      adminRequest('user_reviewer'),
    );
    expect(response.item.creative.status).toBe('approved');
    expect(response.review?.decision).toBe('approved');
    expect(service.reviewCreative).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeId: 'c_1',
        action: 'approve',
        reviewerUserId: 'user_reviewer',
      }),
    );
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      reviewCreative: vi.fn(
        async (): Promise<ReviewCreativeOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.review(
        'missing',
        { action: 'approve', acknowledgeAccessibilityFailures: false },
        adminRequest(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps not_in_review to 409', async () => {
    const { controller } = build({
      reviewCreative: vi.fn(
        async (): Promise<ReviewCreativeOutcome> => ({
          ok: false,
          reason: 'not_in_review',
          status: 'approved',
        }),
      ),
    });
    await expect(
      controller.review(
        'c_1',
        { action: 'reject', notes: 'no', acknowledgeAccessibilityFailures: false },
        adminRequest(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps accessibility_failed to 422 listing the failing checks', async () => {
    const { controller } = build({
      reviewCreative: vi.fn(
        async (): Promise<ReviewCreativeOutcome> => ({
          ok: false,
          reason: 'accessibility_failed',
          report: FAILING_REPORT,
        }),
      ),
    });
    await expect(
      controller.review(
        'c_1',
        { action: 'approve', acknowledgeAccessibilityFailures: false },
        adminRequest(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps override_reason_required to 422', async () => {
    const { controller } = build({
      reviewCreative: vi.fn(
        async (): Promise<ReviewCreativeOutcome> => ({
          ok: false,
          reason: 'override_reason_required',
        }),
      ),
    });
    await expect(
      controller.review(
        'c_1',
        { action: 'approve', acknowledgeAccessibilityFailures: true },
        adminRequest(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('401s without a request context', async () => {
    const { controller } = build();
    await expect(
      controller.review('c_1', { action: 'approve', acknowledgeAccessibilityFailures: false }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
