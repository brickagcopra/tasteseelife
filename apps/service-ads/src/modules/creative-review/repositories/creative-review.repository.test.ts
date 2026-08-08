import { describe, expect, it } from 'vitest';

import { PrismaService } from '../../../prisma/prisma.service';
import { FakeReviewPrisma } from '../services/__fixtures__/fake-prisma';
import { CreativeReviewRepository } from './creative-review.repository';

function build(): { repo: CreativeReviewRepository; prisma: FakeReviewPrisma } {
  const prisma = new FakeReviewPrisma();
  const repo = new CreativeReviewRepository(prisma as unknown as PrismaService);
  return { repo, prisma };
}

const REPORT = {
  passed: true,
  checks: [
    { id: 'motion_safe' as const, status: 'pass' as const, detail: 'ok', contrastRatio: null },
  ],
};

describe('CreativeReviewRepository.listPendingReview', () => {
  it('returns only pending_review creatives, oldest first, bounded by limit', async () => {
    const { repo, prisma } = build();
    prisma.addCreative({ id: 'c_draft', campaignId: 'camp_1', kind: 'banner', status: 'draft' });
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });
    prisma.addCreative({
      id: 'c_2',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });
    prisma.addCreative({ id: 'c_appr', campaignId: 'camp_1', kind: 'banner', status: 'approved' });

    const queue = await repo.listPendingReview(10);
    expect(queue.map((c) => c.id)).toEqual(['c_1', 'c_2']);

    const limited = await repo.listPendingReview(1);
    expect(limited.map((c) => c.id)).toEqual(['c_1']);
  });
});

describe('CreativeReviewRepository.findCreative / findCampaignContext', () => {
  it('reads a creative with its accessibility columns', async () => {
    const { repo, prisma } = build();
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      altText: 'A meal',
      textColor: '#000000',
      backgroundColor: '#ffffff',
      motionSafe: true,
      disclosureAcknowledged: true,
    });
    const creative = await repo.findCreative('c_1');
    expect(creative?.altText).toBe('A meal');
    expect(creative?.textColor).toBe('#000000');
    expect(creative?.disclosureAcknowledged).toBe(true);
    expect(await repo.findCreative('missing')).toBeNull();
  });

  it('reads campaign context and batch-loads contexts', async () => {
    const { repo, prisma } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'partner' });
    prisma.addCampaign({ id: 'camp_2', name: 'Fall', advertiserKind: 'provider' });

    const ctx = await repo.findCampaignContext('camp_1');
    expect(ctx).toEqual(
      expect.objectContaining({ id: 'camp_1', name: 'Spring', advertiserKind: 'partner' }),
    );

    const contexts = await repo.listCampaignContexts(['camp_1', 'camp_2', 'nope']);
    expect(contexts.map((c) => c.id).sort()).toEqual(['camp_1', 'camp_2']);
    expect(await repo.listCampaignContexts([])).toEqual([]);
  });
});

describe('CreativeReviewRepository.updateAccessibility', () => {
  it('applies a partial metadata update', async () => {
    const { repo, prisma } = build();
    prisma.addCreative({ id: 'c_1', campaignId: 'camp_1', kind: 'banner' });
    const updated = await repo.updateAccessibility('c_1', {
      altText: 'A meal',
      disclosureAcknowledged: true,
    });
    expect(updated.altText).toBe('A meal');
    expect(updated.disclosureAcknowledged).toBe(true);
    expect(updated.motionSafe).toBe(true);
  });
});

describe('CreativeReviewRepository.applyReview', () => {
  it('flips the creative status and appends a review row in one transaction', async () => {
    const { repo, prisma } = build();
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });

    const { creative, review } = await repo.applyReview({
      creativeId: 'c_1',
      newStatus: 'approved',
      review: {
        creativeId: 'c_1',
        decision: 'approved',
        reviewerUserId: 'admin_1',
        notes: null,
        accessibilityPassed: true,
        accessibilityReport: REPORT,
        overrodeAccessibility: false,
      },
    });

    expect(creative.status).toBe('approved');
    expect(review.decision).toBe('approved');
    expect(review.reviewerUserId).toBe('admin_1');
    expect(prisma.reviews).toHaveLength(1);

    const history = await repo.listReviews('c_1');
    expect(history).toHaveLength(1);
    expect(history[0]?.accessibilityPassed).toBe(true);
  });
});
