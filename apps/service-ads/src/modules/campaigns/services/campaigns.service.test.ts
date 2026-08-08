import { describe, expect, it, vi } from 'vitest';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  CampaignRepository,
  type AdCampaignRow,
  type AdCreativeRow,
  type AdTargetingRuleRow,
  type CampaignAggregateRows,
} from '../repositories/campaign.repository';
import {
  CampaignsService,
  decimalToMinor,
  minorToDecimalString,
  toTargetingRuleRecord,
} from './campaigns.service';

const D1 = new Date('2026-06-13T00:00:00.000Z');

/** A fake transaction client handed to the `onPersist` callbacks. */
const FAKE_TX = {} as never;

function auditContext(overrides: Partial<AuditActorContext> = {}): AuditActorContext {
  return {
    actorUserId: 'admin_1',
    actorRole: 'marketing',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: '203.0.113.1',
    userAgent: 'jest',
    requestId: 'req_1',
    traceId: null,
    ...overrides,
  };
}

function campaignRow(overrides: Partial<AdCampaignRow> = {}): AdCampaignRow {
  return {
    id: 'camp_1',
    name: 'Spring upsell',
    advertiserKind: 'internal',
    advertiserId: null,
    status: 'draft',
    budget: '5000.00',
    currency: 'USD',
    startAt: null,
    endAt: null,
    createdAt: D1,
    updatedAt: D1,
    ...overrides,
  };
}

function creativeRow(overrides: Partial<AdCreativeRow> = {}): AdCreativeRow {
  return {
    id: 'crea_1',
    campaignId: 'camp_1',
    kind: 'banner',
    assetKeys: [],
    headline: 'Hi',
    body: null,
    ctaUrl: null,
    status: 'draft',
    createdAt: D1,
    updatedAt: D1,
    ...overrides,
  };
}

function ruleRow(overrides: Partial<AdTargetingRuleRow> = {}): AdTargetingRuleRow {
  return {
    id: 'rule_1',
    campaignId: 'camp_1',
    kind: 'geography',
    value: '{"operator":"any_of","values":["NY"]}',
    createdAt: D1,
    updatedAt: D1,
    ...overrides,
  };
}

interface FakeRepo {
  createAggregate: ReturnType<typeof vi.fn>;
  findCampaign: ReturnType<typeof vi.fn>;
  findDetail: ReturnType<typeof vi.fn>;
  listCampaigns: ReturnType<typeof vi.fn>;
  updateCampaign: ReturnType<typeof vi.fn>;
  findCreative: ReturnType<typeof vi.fn>;
  updateCreativeStatus: ReturnType<typeof vi.fn>;
}

interface FakeAudit {
  emit: ReturnType<typeof vi.fn>;
}

/**
 * The fake repo invokes any supplied `onPersist(tx, result)` so the service's
 * audit-emission closures actually fire (mirroring the real repo, which runs
 * the hook inside its transaction) — that's what lets these tests assert the
 * `audit.action_recorded` emission.
 */
function build(overrides: Partial<FakeRepo> = {}): {
  service: CampaignsService;
  repo: FakeRepo;
  audit: FakeAudit;
} {
  const aggregate: CampaignAggregateRows = {
    campaign: campaignRow(),
    creatives: [],
    targetingRules: [],
  };
  const repo: FakeRepo = {
    createAggregate: vi.fn(async (_params, onPersist): Promise<CampaignAggregateRows> => {
      if (onPersist !== undefined) await onPersist(FAKE_TX, aggregate);
      return aggregate;
    }),
    findCampaign: vi.fn(async (): Promise<AdCampaignRow | null> => campaignRow()),
    findDetail: vi.fn(async (): Promise<CampaignAggregateRows | null> => aggregate),
    listCampaigns: vi.fn(async (): Promise<readonly AdCampaignRow[]> => [campaignRow()]),
    updateCampaign: vi.fn(async (_id, _data, onPersist): Promise<AdCampaignRow> => {
      const row = campaignRow({ status: 'active' });
      if (onPersist !== undefined) await onPersist(FAKE_TX, row);
      return row;
    }),
    findCreative: vi.fn(async (): Promise<AdCreativeRow | null> => creativeRow()),
    updateCreativeStatus: vi.fn(async (_id, status, onPersist): Promise<AdCreativeRow> => {
      const row = creativeRow({ status });
      if (onPersist !== undefined) await onPersist(FAKE_TX, row);
      return row;
    }),
    ...overrides,
  };
  const audit: FakeAudit = { emit: vi.fn(async () => undefined) };
  const service = new CampaignsService(
    repo as unknown as CampaignRepository,
    audit as unknown as AuditEmitter,
  );
  return { service, repo, audit };
}

describe('money boundary helpers', () => {
  it('minorToDecimalString renders cents without float drift', () => {
    expect(minorToDecimalString(0)).toBe('0.00');
    expect(minorToDecimalString(5)).toBe('0.05');
    expect(minorToDecimalString(500000)).toBe('5000.00');
    expect(minorToDecimalString(99_999_999)).toBe('999999.99');
  });

  it('decimalToMinor round-trips a fixed-2 string / number / Decimal-like', () => {
    expect(decimalToMinor(null)).toBeNull();
    expect(decimalToMinor('5000.00')).toBe(500000);
    expect(decimalToMinor('0.05')).toBe(5);
    expect(decimalToMinor(1234.5)).toBe(123450);
    expect(decimalToMinor({ toFixed: () => '42.00' })).toBe(4200);
  });
});

describe('toTargetingRuleRecord', () => {
  it('decodes a valid persisted AST', () => {
    const record = toTargetingRuleRecord(ruleRow());
    expect(record?.predicate).toEqual({ operator: 'any_of', values: ['NY'] });
  });

  it('returns null for an undecodable value (fail-closed)', () => {
    expect(toTargetingRuleRecord(ruleRow({ value: 'not json' }))).toBeNull();
    expect(
      toTargetingRuleRecord(ruleRow({ value: '{"operator":"bogus","values":[]}' })),
    ).toBeNull();
  });
});

describe('createCampaign', () => {
  it('converts budgetMinor to a Decimal string + encodes targeting predicates', async () => {
    const { service, repo } = build();
    const outcome = await service.createCampaign({
      name: 'Spring',
      advertiserKind: 'internal',
      advertiserId: null,
      currency: 'USD',
      status: 'draft',
      budgetMinor: 500000,
      startAt: '2026-06-13T00:00:00.000Z',
      creatives: [{ kind: 'banner', assetKeys: [], headline: 'Hi', status: 'draft' }],
      targetingRules: [{ kind: 'geography', predicate: { operator: 'any_of', values: ['NY'] } }],
      actorUserId: 'admin_1',
      audit: auditContext(),
    });

    expect(outcome.ok).toBe(true);
    const call = repo.createAggregate.mock.calls[0]![0];
    expect(call.campaign.budget).toBe('5000.00');
    expect(call.campaign.startAt).toBeInstanceOf(Date);
    expect(call.targetingRules[0].value).toBe('{"operator":"any_of","values":["NY"]}');
  });

  it('emits an ad_campaign:create audit event with the actor + null before', async () => {
    const { service, audit } = build();
    await service.createCampaign({
      name: 'Spring',
      advertiserKind: 'internal',
      advertiserId: null,
      currency: 'USD',
      status: 'draft',
      actorUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, actor, descriptor] = audit.emit.mock.calls[0]!;
    expect(actor).toMatchObject({ actorUserId: 'admin_1', actorRole: 'marketing' });
    expect(descriptor).toMatchObject({
      action: 'ad_campaign:create',
      resourceKind: 'ad_campaign',
      resourceId: 'camp_1',
      before: null,
    });
    expect(descriptor.after).toMatchObject({ id: 'camp_1' });
  });

  it('passes a null budget through when budgetMinor is omitted', async () => {
    const { service, repo } = build();
    await service.createCampaign({
      name: 'Spring',
      advertiserKind: 'internal',
      advertiserId: null,
      currency: 'USD',
      status: 'draft',
      actorUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(repo.createAggregate.mock.calls[0]![0].campaign.budget).toBeNull();
  });

  it('rejects a non-USD currency without auditing', async () => {
    const { service, repo, audit } = build();
    const outcome = await service.createCampaign({
      name: 'Spring',
      advertiserKind: 'internal',
      advertiserId: null,
      currency: 'EUR',
      status: 'draft',
      actorUserId: 'admin_1',
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_currency' });
    expect(repo.createAggregate).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });
});

describe('getCampaignDetail', () => {
  it('maps the aggregate and omits an undecodable rule', async () => {
    const { service } = build({
      findDetail: vi.fn(
        async (): Promise<CampaignAggregateRows> => ({
          campaign: campaignRow(),
          creatives: [creativeRow()],
          targetingRules: [ruleRow(), ruleRow({ id: 'rule_2', value: 'corrupt' })],
        }),
      ),
    });
    const outcome = await service.getCampaignDetail('camp_1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.campaign.budgetMinor).toBe(500000);
      expect(outcome.campaign.creatives).toHaveLength(1);
      expect(outcome.campaign.targetingRules).toHaveLength(1); // corrupt rule omitted
    }
  });

  it('returns not_found when the campaign does not resolve', async () => {
    const { service } = build({ findDetail: vi.fn(async () => null) });
    expect(await service.getCampaignDetail('camp_x')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('updateCampaign', () => {
  it('returns not_found for an unknown campaign', async () => {
    const { service, audit } = build({ findCampaign: vi.fn(async () => null) });
    expect(
      await service.updateCampaign({
        campaignId: 'x',
        status: 'active',
        actorUserId: 'a',
        audit: auditContext(),
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('rejects an illegal status transition', async () => {
    const { service } = build({
      findCampaign: vi.fn(async () => campaignRow({ status: 'completed' })),
    });
    const outcome = await service.updateCampaign({
      campaignId: 'camp_1',
      status: 'active',
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
      from: 'completed',
      to: 'active',
    });
  });

  it('rejects an unsupported currency', async () => {
    const { service } = build();
    expect(
      await service.updateCampaign({
        campaignId: 'camp_1',
        currency: 'GBP',
        actorUserId: 'a',
        audit: auditContext(),
      }),
    ).toEqual({ ok: false, reason: 'unsupported_currency' });
  });

  it('rejects clearing the advertiserId on a provider campaign', async () => {
    const { service } = build({
      findCampaign: vi.fn(async () =>
        campaignRow({ advertiserKind: 'provider', advertiserId: 'p1' }),
      ),
    });
    expect(
      await service.updateCampaign({
        campaignId: 'camp_1',
        advertiserId: null,
        actorUserId: 'a',
        audit: auditContext(),
      }),
    ).toEqual({ ok: false, reason: 'advertiser_required' });
  });

  it('rejects setting an advertiserId on an internal house ad', async () => {
    const { service } = build();
    expect(
      await service.updateCampaign({
        campaignId: 'camp_1',
        advertiserId: 'p1',
        actorUserId: 'a',
        audit: auditContext(),
      }),
    ).toEqual({ ok: false, reason: 'advertiser_not_allowed' });
  });

  it('rejects a window where the merged endAt is not after startAt', async () => {
    const { service } = build({
      findCampaign: vi.fn(async () =>
        campaignRow({ startAt: new Date('2026-06-20T00:00:00.000Z') }),
      ),
    });
    const outcome = await service.updateCampaign({
      campaignId: 'camp_1',
      endAt: '2026-06-19T00:00:00.000Z',
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_window' });
  });

  it('applies a valid status transition + budget clear, auditing before + after', async () => {
    const { service, repo, audit } = build();
    const outcome = await service.updateCampaign({
      campaignId: 'camp_1',
      status: 'active',
      budgetMinor: null,
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    const patch = repo.updateCampaign.mock.calls[0]![1];
    expect(patch.status).toBe('active');
    expect(patch.budget).toBeNull();
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({ action: 'ad_campaign:update', resourceKind: 'ad_campaign' });
    expect(descriptor.before).toMatchObject({ status: 'draft' });
    expect(descriptor.after).toMatchObject({ status: 'active' });
  });
});

describe('updateCreativeStatus', () => {
  it('returns not_found when the creative does not resolve', async () => {
    const { service, audit } = build({ findCreative: vi.fn(async () => null) });
    expect(
      await service.updateCreativeStatus({
        campaignId: 'camp_1',
        creativeId: 'crea_x',
        status: 'approved',
        actorUserId: 'a',
        audit: auditContext(),
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('rejects an illegal creative transition', async () => {
    const { service } = build({
      findCreative: vi.fn(async () => creativeRow({ status: 'draft' })),
    });
    const outcome = await service.updateCreativeStatus({
      campaignId: 'camp_1',
      creativeId: 'crea_1',
      status: 'approved',
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_transition' });
  });

  it('is a no-op success on a same-status set (no write, no audit)', async () => {
    const { service, repo, audit } = build({
      findCreative: vi.fn(async () => creativeRow({ status: 'approved' })),
    });
    const outcome = await service.updateCreativeStatus({
      campaignId: 'camp_1',
      creativeId: 'crea_1',
      status: 'approved',
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    expect(repo.updateCreativeStatus).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('advances a creative through a valid transition, auditing the status change', async () => {
    const { service, repo, audit } = build({
      findCreative: vi.fn(async () => creativeRow({ status: 'pending_review' })),
    });
    const outcome = await service.updateCreativeStatus({
      campaignId: 'camp_1',
      creativeId: 'crea_1',
      status: 'approved',
      actorUserId: 'a',
      audit: auditContext(),
    });
    expect(outcome.ok).toBe(true);
    expect(repo.updateCreativeStatus).toHaveBeenCalledWith(
      'crea_1',
      'approved',
      expect.any(Function),
    );
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, , descriptor] = audit.emit.mock.calls[0]!;
    expect(descriptor).toMatchObject({
      action: 'ad_creative:status_changed',
      resourceKind: 'ad_creative',
      resourceId: 'crea_1',
    });
    expect(descriptor.before).toMatchObject({ status: 'pending_review' });
    expect(descriptor.after).toMatchObject({ status: 'approved' });
  });
});
