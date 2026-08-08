import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { CreativeReviewRepository } from '../repositories/creative-review.repository';
import { FakeReviewPrisma } from './__fixtures__/fake-prisma';
import { CreativeReviewService } from './creative-review.service';

interface FakeAudit {
  emit: ReturnType<typeof vi.fn>;
}

function build(): { service: CreativeReviewService; prisma: FakeReviewPrisma; audit: FakeAudit } {
  const prisma = new FakeReviewPrisma();
  const repo = new CreativeReviewRepository(prisma as unknown as PrismaService);
  const audit: FakeAudit = { emit: vi.fn(async () => undefined) };
  const service = new CreativeReviewService(repo, audit as unknown as AuditEmitter);
  return { service, prisma, audit };
}

function auditContext(): AuditActorContext {
  return {
    actorUserId: 'admin_1',
    actorRole: 'marketing',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: null,
    userAgent: null,
    requestId: null,
    traceId: null,
  };
}

/** A creative that passes every accessibility check (image-bearing + complete). */
function seedAccessibleBanner(prisma: FakeReviewPrisma, id = 'c_1', campaignId = 'camp_1'): void {
  prisma.addCampaign({
    id: campaignId,
    name: 'Spring',
    advertiserKind: 'partner',
    advertiserId: 'p_1',
  });
  prisma.addCreative({
    id,
    campaignId,
    kind: 'banner',
    status: 'pending_review',
    altText: 'A warm chef-prepared meal',
    textColor: '#000000',
    backgroundColor: '#ffffff',
    motionSafe: true,
    disclosureAcknowledged: true,
  });
}

describe('CreativeReviewService.getReviewQueue', () => {
  it('returns pending creatives with live reports + campaign context', async () => {
    const { service, prisma } = build();
    seedAccessibleBanner(prisma);
    const items = await service.getReviewQueue(50);
    expect(items).toHaveLength(1);
    expect(items[0]?.creative.id).toBe('c_1');
    expect(items[0]?.campaign.name).toBe('Spring');
    expect(items[0]?.accessibility.passed).toBe(true);
    expect(items[0]?.accessibilityMetadata.altText).toBe('A warm chef-prepared meal');
  });

  it('skips a creative whose campaign context is missing', async () => {
    const { service, prisma } = build();
    prisma.addCreative({ id: 'c_1', campaignId: 'gone', kind: 'banner', status: 'pending_review' });
    expect(await service.getReviewQueue(50)).toEqual([]);
  });
});

describe('CreativeReviewService.getReviewDetail', () => {
  it('returns not_found for an unknown creative', async () => {
    const { service } = build();
    const outcome = await service.getReviewDetail('missing');
    expect(outcome.ok).toBe(false);
  });

  it('returns the item plus its review history newest-first', async () => {
    const { service, prisma } = build();
    seedAccessibleBanner(prisma);
    await service.reviewCreative({
      creativeId: 'c_1',
      action: 'request_changes',
      notes: 'tighten the headline',
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    // Re-submit so a second review can be recorded.
    prisma.creatives.find((c) => c['id'] === 'c_1')!['status'] = 'pending_review';
    await service.reviewCreative({
      creativeId: 'c_1',
      action: 'approve',
      notes: undefined,
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_2',
      audit: auditContext(),
    });

    const outcome = await service.getReviewDetail('c_1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reviews).toHaveLength(2);
    expect(outcome.reviews[0]?.decision).toBe('approved');
    expect(outcome.reviews[1]?.decision).toBe('changes_requested');
  });
});

describe('CreativeReviewService.updateAccessibility', () => {
  it('returns not_found for an unknown creative', async () => {
    const { service } = build();
    const outcome = await service.updateAccessibility({
      creativeId: 'missing',
      actorUserId: 'admin_1',
      altText: 'x',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(false);
  });

  it('applies metadata, recomputes the report, and audits the edit', async () => {
    const { service, prisma, audit } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'internal' });
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });

    const before = await service.getReviewDetail('c_1');
    expect(before.ok && before.item.accessibility.passed).toBe(false);

    const outcome = await service.updateAccessibility({
      creativeId: 'c_1',
      actorUserId: 'admin_1',
      altText: 'A warm meal',
      textColor: '#000000',
      backgroundColor: '#ffffff',
      disclosureAcknowledged: true,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.accessibility.passed).toBe(true);
    expect(outcome.item.accessibilityMetadata.disclosureAcknowledged).toBe(true);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({
      action: 'ad_creative:accessibility_updated',
      resourceKind: 'ad_creative',
      resourceId: 'c_1',
    });
    expect(descriptor.after).toMatchObject({ disclosureAcknowledged: true });
  });
});

describe('CreativeReviewService.reviewCreative', () => {
  it('returns not_found for an unknown creative', async () => {
    const { service } = build();
    const outcome = await service.reviewCreative({
      creativeId: 'missing',
      action: 'approve',
      notes: undefined,
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_found');
  });

  it('rejects a creative that is not pending_review', async () => {
    const { service, prisma } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'internal' });
    prisma.addCreative({ id: 'c_1', campaignId: 'camp_1', kind: 'banner', status: 'approved' });
    const outcome = await service.reviewCreative({
      creativeId: 'c_1',
      action: 'reject',
      notes: 'no',
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_in_review');
  });

  it('approves an accessible creative, records the decision, and audits the review', async () => {
    const { service, prisma, audit } = build();
    seedAccessibleBanner(prisma);
    const outcome = await service.reviewCreative({
      creativeId: 'c_1',
      action: 'approve',
      notes: undefined,
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.creative.status).toBe('approved');
    expect(outcome.review.decision).toBe('approved');
    expect(outcome.review.overrodeAccessibility).toBe(false);
    expect(outcome.review.accessibilityPassed).toBe(true);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({
      action: 'ad_creative:reviewed',
      resourceKind: 'ad_creative',
      resourceId: 'c_1',
    });
    expect(descriptor.after).toMatchObject({
      status: 'approved',
      decision: 'approved',
      accessibilityPassed: true,
    });
  });

  it('blocks approval when accessibility fails and is not acknowledged (no audit)', async () => {
    const { service, prisma, audit } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'internal' });
    // banner with no alt text / colours → fails alt + contrast + disclosure.
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });
    const outcome = await service.reviewCreative({
      creativeId: 'c_1',
      action: 'approve',
      notes: undefined,
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('accessibility_failed');
    if (outcome.reason !== 'accessibility_failed') return;
    expect(outcome.report.passed).toBe(false);
    // No review row was written, and no audit event emitted.
    expect(prisma.reviews).toHaveLength(0);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('requires notes to override a failing report', async () => {
    const { service, prisma } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'internal' });
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });
    const outcome = await service.reviewCreative({
      creativeId: 'c_1',
      action: 'approve',
      notes: undefined,
      acknowledgeAccessibilityFailures: true,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('override_reason_required');
  });

  it('approves with an audited override when acknowledged with notes', async () => {
    const { service, prisma } = build();
    prisma.addCampaign({ id: 'camp_1', name: 'Spring', advertiserKind: 'internal' });
    prisma.addCreative({
      id: 'c_1',
      campaignId: 'camp_1',
      kind: 'banner',
      status: 'pending_review',
    });
    const outcome = await service.reviewCreative({
      creativeId: 'c_1',
      action: 'approve',
      notes: 'house ad; contrast verified manually against the rendered asset',
      acknowledgeAccessibilityFailures: true,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.creative.status).toBe('approved');
    expect(outcome.review.overrodeAccessibility).toBe(true);
    expect(outcome.review.accessibilityPassed).toBe(false);
    expect(outcome.review.notes).toContain('house ad');
  });

  it('rejects with notes and bounces the creative back via request_changes', async () => {
    const { service, prisma } = build();
    seedAccessibleBanner(prisma, 'c_reject');
    const rejected = await service.reviewCreative({
      creativeId: 'c_reject',
      action: 'reject',
      notes: 'off-brand imagery',
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(rejected.ok && rejected.item.creative.status).toBe('rejected');

    seedAccessibleBanner(prisma, 'c_changes', 'camp_2');
    const changes = await service.reviewCreative({
      creativeId: 'c_changes',
      action: 'request_changes',
      notes: 'shorten the headline',
      acknowledgeAccessibilityFailures: false,
      reviewerUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(changes.ok && changes.item.creative.status).toBe('draft');
    if (!changes.ok) return;
    expect(changes.review.decision).toBe('changes_requested');
  });
});
