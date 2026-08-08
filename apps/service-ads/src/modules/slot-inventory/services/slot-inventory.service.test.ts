import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { FakeSlotPrisma } from '../__fixtures__/fake-prisma';
import { SlotInventoryRepository } from '../repositories/slot-inventory.repository';
import { SlotInventoryService } from './slot-inventory.service';

interface FakeAudit {
  emit: ReturnType<typeof vi.fn>;
}

function build(): { service: SlotInventoryService; prisma: FakeSlotPrisma; audit: FakeAudit } {
  const prisma = new FakeSlotPrisma();
  const repo = new SlotInventoryRepository(prisma as unknown as PrismaService);
  const audit: FakeAudit = { emit: vi.fn(async () => undefined) };
  const service = new SlotInventoryService(repo, audit as unknown as AuditEmitter);
  return { service, prisma, audit };
}

function auditContext(): AuditActorContext {
  return {
    actorUserId: 'usr_admin',
    actorRole: 'marketing',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: null,
    userAgent: null,
    requestId: null,
    traceId: null,
  };
}

const ACTOR = 'usr_admin';
const START = '2026-07-01T00:00:00.000Z';
const END = '2026-07-31T00:00:00.000Z';

describe('SlotInventoryService.listPlacements', () => {
  it('maps placement rows to ISO records', async () => {
    const { service, prisma } = build();
    prisma.seedPlacement('home_banner', ['banner']);

    const placements = await service.listPlacements();
    expect(placements).toHaveLength(1);
    expect(placements[0]?.slotCode).toBe('home_banner');
    expect(placements[0]?.supportedCreativeKinds).toEqual(['banner']);
    expect(typeof placements[0]?.createdAt).toBe('string');
  });
});

describe('SlotInventoryService.createSchedule', () => {
  it('rejects an unknown placement', async () => {
    const { service, prisma } = build();
    const campaignId = prisma.seedCampaign();

    const outcome = await service.createSchedule({
      placementId: 'plc_missing',
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'placement_not_found' });
  });

  it('rejects an unknown campaign', async () => {
    const { service, prisma } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);

    const outcome = await service.createSchedule({
      placementId,
      campaignId: 'camp_missing',
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'campaign_not_found' });
  });

  it('books a campaign into a placement and audits the create', async () => {
    const { service, prisma, audit } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    const campaignId = prisma.seedCampaign([{ kind: 'banner', status: 'approved' }]);

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      endAt: END,
      priority: 3,
      status: 'active',
      actorUserId: ACTOR,
      audit: auditContext(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.schedule.status).toBe('active');
    expect(outcome.schedule.priority).toBe(3);
    expect(outcome.schedule.startAt).toBe(START);
    expect(outcome.schedule.endAt).toBe(END);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({
      action: 'ad_slot_schedule:create',
      resourceKind: 'ad_slot_schedule',
      before: null,
    });
    expect(descriptor.after).toMatchObject({ status: 'active' });
  });

  it('does not audit a rejected create', async () => {
    const { service, prisma, audit } = build();
    prisma.seedPlacement('home_banner', ['banner']);
    await service.createSchedule({
      placementId: 'plc_missing',
      campaignId: 'camp_missing',
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('persists a null endAt for an open-ended schedule', async () => {
    const { service, prisma } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    const campaignId = prisma.seedCampaign([{ kind: 'banner', status: 'approved' }]);

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.schedule.endAt).toBeNull();
  });

  // ── Creative-kind ↔ placement compatibility (TS-272a-followup-3) ─────────

  it('rejects a campaign whose only approved creative is an unsupported kind', async () => {
    const { service, prisma } = build();
    // search_top_tile serves only sponsored_listing; the campaign offers banner.
    const placementId = prisma.seedPlacement('search_top_tile', ['sponsored_listing']);
    const campaignId = prisma.seedCampaign([{ kind: 'banner', status: 'approved' }]);

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'incompatible_creative_kind',
      supportedKinds: ['sponsored_listing'],
      approvedKinds: ['banner'],
    });
  });

  it('rejects a campaign whose compatible creative is not yet approved', async () => {
    const { service, prisma } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    // The banner creative is still pending review — no approved kind to deliver.
    const campaignId = prisma.seedCampaign([{ kind: 'banner', status: 'pending_review' }]);

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'incompatible_creative_kind',
      supportedKinds: ['banner'],
      approvedKinds: [],
    });
  });

  it('rejects a campaign with no creatives at all', async () => {
    const { service, prisma } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    const campaignId = prisma.seedCampaign();

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'incompatible_creative_kind',
      supportedKinds: ['banner'],
      approvedKinds: [],
    });
  });

  it('books when at least one approved creative kind matches a multi-kind placement', async () => {
    const { service, prisma } = build();
    // dashboard_sidebar serves banner + sponsored_content.
    const placementId = prisma.seedPlacement('dashboard_sidebar', ['banner', 'sponsored_content']);
    const campaignId = prisma.seedCampaign([
      { kind: 'banner', status: 'draft' }, // not approved
      { kind: 'sponsored_content', status: 'approved' }, // approved + supported → matches
    ]);

    const outcome = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('SlotInventoryService.updateSchedule', () => {
  async function seedSchedule(): Promise<{
    service: SlotInventoryService;
    audit: FakeAudit;
    scheduleId: string;
  }> {
    const { service, prisma, audit } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    const campaignId = prisma.seedCampaign([{ kind: 'banner', status: 'approved' }]);
    const created = await service.createSchedule({
      placementId,
      campaignId,
      startAt: START,
      endAt: END,
      priority: 0,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    if (!created.ok) throw new Error('seed failed');
    // Drop the create's audit emission so update-path assertions count cleanly.
    audit.emit.mockClear();
    return { service, audit, scheduleId: created.schedule.id };
  }

  it('returns not_found for an unknown schedule without auditing', async () => {
    const { service, audit } = build();
    const outcome = await service.updateSchedule({
      scheduleId: 'sch_nope',
      status: 'active',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('rejects a disallowed status transition', async () => {
    const { service, scheduleId } = await seedSchedule();
    const outcome = await service.updateSchedule({
      scheduleId,
      status: 'completed', // scheduled → completed is not allowed
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid_transition',
      from: 'scheduled',
      to: 'completed',
    });
  });

  it('rejects a merged window that ends before it starts', async () => {
    const { service, scheduleId } = await seedSchedule();
    const outcome = await service.updateSchedule({
      scheduleId,
      startAt: '2026-08-01T00:00:00.000Z', // after the existing END
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_window' });
  });

  it('applies a valid transition + priority change and audits the update', async () => {
    const { service, audit, scheduleId } = await seedSchedule();
    const outcome = await service.updateSchedule({
      scheduleId,
      status: 'active',
      priority: 9,
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.schedule.status).toBe('active');
    expect(outcome.schedule.priority).toBe(9);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({
      action: 'ad_slot_schedule:update',
      resourceKind: 'ad_slot_schedule',
    });
    expect(descriptor.before).toMatchObject({ status: 'scheduled' });
    expect(descriptor.after).toMatchObject({ status: 'active' });
  });

  it('clears the window when endAt is set to null', async () => {
    const { service, scheduleId } = await seedSchedule();
    const outcome = await service.updateSchedule({
      scheduleId,
      endAt: null,
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.schedule.endAt).toBeNull();
  });

  it('treats a same-status set as a no-op success', async () => {
    const { service, scheduleId } = await seedSchedule();
    const outcome = await service.updateSchedule({
      scheduleId,
      status: 'scheduled',
      actorUserId: ACTOR,
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.schedule.status).toBe('scheduled');
  });
});
