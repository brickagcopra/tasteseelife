import type { OutboxService } from '@taste-and-see/nest-outbox';
import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuditActorContext, type AuditEmitter } from '@taste-and-see/nest-audit';

import type { PrismaService } from '../../../prisma/prisma.service';

import { CertificationsMetrics } from './certifications-metrics';
import { ProviderCertificationsService } from './provider-certifications.service';
import {
  computeEligibleTier,
  TierPromotionService,
  type ProviderRowForPromotion,
  type ProviderTierHistoryRow,
} from './tier-promotion.service';

/**
 * Minimal `OutboxService` stand-in for unit tests. Records calls and
 * returns `appended` by default; `setNextValidationFailure` flips the
 * next call to a typed `validation_failed` outcome so the rollback
 * path can be exercised.
 */
interface FakeOutboxAppendCall {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: unknown;
}
interface FakeOutbox {
  readonly calls: FakeOutboxAppendCall[];
  readonly append: ReturnType<typeof vi.fn>;
  setNextValidationFailure(reason: string): void;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: FakeOutboxAppendCall[] = [];
  let nextFailure: string | null = null;
  const append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; eventId?: string; payload: unknown },
    ): Promise<
      | {
          kind: 'appended';
          eventId: string;
          eventName: string;
          occurredAt: Date;
        }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      calls.push({
        eventName: args.eventName,
        eventId: args.eventId,
        payload: args.payload,
      });
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: [], message: failure }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? 'evt_fake',
        eventName: args.eventName,
        occurredAt: new Date('2026-05-16T12:00:00.000Z'),
      };
    },
  );
  return {
    calls,
    append,
    setNextValidationFailure(reason) {
      nextFailure = reason;
    },
  };
}
function asOutboxService(fake: FakeOutbox): OutboxService {
  return { append: fake.append } as unknown as OutboxService;
}

class FakePrisma {
  public providers: ProviderRowForPromotion[] = [];
  public history: ProviderTierHistoryRow[] = [];
  private autoId = 0;

  provider = {
    findUnique: vi.fn(
      async (args: { where: { id: string } }): Promise<ProviderRowForPromotion | null> => {
        return this.providers.find((p) => p.id === args.where.id) ?? null;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: { tier: 'basic' | 'certified' | 'elite' };
      }): Promise<ProviderRowForPromotion> => {
        const target = this.providers.find((p) => p.id === args.where.id);
        if (target === undefined) throw new Error('provider not found');
        const next: ProviderRowForPromotion = {
          id: target.id,
          status: target.status,
          tier: args.data.tier,
        };
        const idx = this.providers.indexOf(target);
        this.providers[idx] = next;
        return next;
      },
    ),
  };

  providerTierHistory = {
    findMany: vi.fn(
      async (args: {
        where: { providerId: string };
        orderBy: { occurredAt: 'asc' | 'desc' };
      }): Promise<ProviderTierHistoryRow[]> => {
        const filtered = this.history.filter((h) => h.providerId === args.where.providerId);
        const sign = args.orderBy.occurredAt === 'asc' ? 1 : -1;
        filtered.sort((a, b) => (a.occurredAt.getTime() - b.occurredAt.getTime()) * sign);
        return filtered;
      },
    ),
    create: vi.fn(
      async (args: { data: Record<string, unknown> }): Promise<ProviderTierHistoryRow> => {
        this.autoId += 1;
        const row: ProviderTierHistoryRow = {
          id: `th_${this.autoId}`,
          providerId: args.data['providerId'] as string,
          fromTier: (args.data['fromTier'] as ProviderRowForPromotion['tier'] | undefined) ?? null,
          toTier: args.data['toTier'] as ProviderRowForPromotion['tier'],
          reason: args.data['reason'] as 'auto_evaluation' | 'admin_override',
          triggeredByUserId: (args.data['triggeredByUserId'] as string | undefined) ?? null,
          notes: (args.data['notes'] as string | undefined) ?? null,
          occurredAt: new Date('2026-05-11T12:00:00.000Z'),
          createdAt: new Date('2026-05-11T12:00:00.000Z'),
        };
        this.history.push(row);
        return row;
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(
      fn: (tx: {
        provider: FakePrisma['provider'];
        providerTierHistory: FakePrisma['providerTierHistory'];
      }) => Promise<T>,
    ): Promise<T> => {
      return fn({
        provider: this.provider,
        providerTierHistory: this.providerTierHistory,
      });
    },
  );
}

function buildCertifications(active: ReadonlySet<string>): ProviderCertificationsService {
  return {
    listActiveCodes: vi.fn(async () => active),
  } as unknown as ProviderCertificationsService;
}

/**
 * TS-305a-followup-1 — a fake audit emitter plus a stand-in actor context.
 *  is a REQUIRED input on every write path in this service, so an
 * unaudited credential or tier change is not representable; these fixtures
 * are what the unit tests pass instead of a real emitter.
 */
const AUDIT_ACTOR = {
  actorUserId: 'user_ops',
  actorRole: 'super_admin',
  actorTenantScopeType: 'global',
  actorTenantScopeId: null,
  ip: null,
  userAgent: null,
  requestId: null,
  traceId: null,
} as unknown as AuditActorContext;

function buildFakeAudit(): AuditEmitter {
  const emitted: unknown[] = [];
  return {
    emit: async (_tx: unknown, _actor: unknown, d: unknown) => {
      emitted.push(d);
    },
    emitted,
  } as unknown as AuditEmitter;
}

describe('computeEligibleTier (pure)', () => {
  it('returns basic when no qualifying certs', () => {
    expect(computeEligibleTier(new Set())).toBe('basic');
    expect(computeEligibleTier(new Set(['dementia_sensitive']))).toBe('basic');
  });

  it('returns certified when only CCC', () => {
    expect(computeEligibleTier(new Set(['ccc']))).toBe('certified');
  });

  it('returns elite when CCC + ECC', () => {
    expect(computeEligibleTier(new Set(['ccc', 'ecc']))).toBe('elite');
  });

  it('returns basic when only ECC (CCC is the prerequisite gate)', () => {
    // Edge case: holding ECC without CCC shouldn't elevate. PRD §5.2
    // implies ECC builds on CCC; the rule encodes that explicitly.
    expect(computeEligibleTier(new Set(['ecc']))).toBe('basic');
  });
});

describe('TierPromotionService.evaluateAndApply', () => {
  it('promotes basic → certified when CCC is held', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({
      providerId: 'prov_1',
      triggeredByUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousTier).toBe('basic');
    expect(result.value.nextTier).toBe('certified');
    expect(result.value.applied).toBe(true);
    expect(result.value.history?.reason).toBe('auto_evaluation');
    expect(result.value.history?.triggeredByUserId).toBe('user_ops');
    expect(prisma.providers[0]?.tier).toBe('certified');
  });

  it('promotes certified → elite when CCC + ECC are held', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'certified' }];
    const certs = buildCertifications(new Set(['ccc', 'ecc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextTier).toBe('elite');
    expect(result.value.applied).toBe(true);
  });

  it('demotes elite → certified when ECC lapses', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'elite' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousTier).toBe('elite');
    expect(result.value.nextTier).toBe('certified');
    expect(result.value.applied).toBe(true);
  });

  it('is a no-op when current tier matches eligible tier', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'certified' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect(result.value.history).toBeNull();
    expect(prisma.providers[0]?.tier).toBe('certified');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('respects dryRun (returns projection but does not write)', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({
      providerId: 'prov_1',
      dryRun: true,
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousTier).toBe('basic');
    expect(result.value.nextTier).toBe('certified');
    expect(result.value.applied).toBe(false);
    expect(result.value.history).toBeNull();
    expect(prisma.providers[0]?.tier).toBe('basic');
  });

  it('rejects an empty providerId', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: '', audit: AUDIT_ACTOR });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('returns provider_not_found for an unknown id', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_missing', audit: AUDIT_ACTOR });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('provider_not_found');
  });

  it('writes the history row inside the same transaction as the provider update', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.providerTierHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.provider.update).toHaveBeenCalledTimes(1);
  });

  it('emits provider.tier_changed via the outbox when a transition lands', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const outbox = buildFakeOutbox();
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({
      providerId: 'prov_1',
      triggeredByUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe('provider.tier_changed');
    expect(call?.eventId).toBe(`${result.value.history?.id}.tier_changed`);
    const payload = call?.payload as Record<string, unknown> | undefined;
    expect(payload?.['providerId']).toBe('prov_1');
    expect(payload?.['fromTier']).toBe('basic');
    expect(payload?.['toTier']).toBe('certified');
    expect(payload?.['reason']).toBe('auto_evaluation');
    expect(payload?.['triggeredByUserId']).toBe('user_ops');
  });

  it('does NOT emit provider.tier_changed when the transition is a no-op (no tier change)', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'certified' }];
    const certs = buildCertifications(new Set(['ccc']));
    const outbox = buildFakeOutbox();
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect(outbox.calls).toHaveLength(0);
  });

  it('surfaces outbox_validation_failed and aborts the transaction on payload rejection', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('bad tier payload');
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe('provider.tier_changed');
  });
});

describe('TierPromotionService.overrideTier', () => {
  it('applies the override and records admin_override history', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'elite' }];
    const certs = buildCertifications(new Set(['ccc', 'ecc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.overrideTier({
      providerId: 'prov_1',
      targetTier: 'basic',
      triggeredByUserId: 'user_ops',
      notes: 'Demoting pending complaint review.',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousTier).toBe('elite');
    expect(result.value.nextTier).toBe('basic');
    expect(result.value.applied).toBe(true);
    expect(result.value.history?.reason).toBe('admin_override');
    expect(result.value.history?.notes).toBe('Demoting pending complaint review.');
    expect(prisma.providers[0]?.tier).toBe('basic');
  });

  it('is a no-op when the target equals the current tier', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.overrideTier({
      providerId: 'prov_1',
      targetTier: 'basic',
      triggeredByUserId: 'user_ops',
      notes: 'confirming no-op',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect(result.value.history).toBeNull();
  });

  it('rejects an empty providerId / triggeredByUserId / notes', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const cases = [
      { providerId: '', triggeredByUserId: 'u', notes: 'n' },
      { providerId: 'p', triggeredByUserId: '', notes: 'n' },
      { providerId: 'p', triggeredByUserId: 'u', notes: '' },
    ] as const;
    for (const params of cases) {
      const result = await svc.overrideTier({
        ...params,
        targetTier: 'basic',
        audit: AUDIT_ACTOR,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('returns provider_not_found for an unknown id', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.overrideTier({
      providerId: 'prov_missing',
      targetTier: 'certified',
      triggeredByUserId: 'user_ops',
      notes: 'n',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('provider_not_found');
  });
});

describe('TierPromotionService.getHistory', () => {
  it('returns rows newest-first', async () => {
    const prisma = new FakePrisma();
    prisma.history = [
      {
        id: 'th_old',
        providerId: 'prov_1',
        fromTier: null,
        toTier: 'basic',
        reason: 'auto_evaluation',
        triggeredByUserId: null,
        notes: null,
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'th_new',
        providerId: 'prov_1',
        fromTier: 'basic',
        toTier: 'certified',
        reason: 'auto_evaluation',
        triggeredByUserId: null,
        notes: null,
        occurredAt: new Date('2026-04-01T00:00:00.000Z'),
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    ];
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const list = await svc.getHistory('prov_1');

    expect(list.map((h) => h.id)).toEqual(['th_new', 'th_old']);
  });

  it('returns an empty list for an empty providerId', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    expect(await svc.getHistory('')).toEqual([]);
    expect(prisma.providerTierHistory.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Observability wiring (TS-052-followup-9). A real MeterProvider is booted
 * so the `CertificationsMetrics` passed here binds to the live meter; the
 * service drives each path end-to-end and the Prometheus exposition is
 * asserted. The transition counter is recorded only on an applied change.
 */
describe('TierPromotionService — observability', () => {
  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records an applied evaluate as a from/to/auto_evaluation transition + ok latency', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.evaluateAndApply({
      providerId: 'prov_1',
      triggeredByUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_evaluate_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_tier_transitions_total\{[^}]*from="basic"[^}]*to="certified"[^}]*reason="auto_evaluation"[^}]*\} 1/,
    );
  });

  it('records a no-op evaluate as ok latency with no transition', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'certified' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.evaluateAndApply({ providerId: 'prov_1', audit: AUDIT_ACTOR });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_evaluate_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
    expect(out).not.toMatch(/provider_tier_transitions_total/);
  });

  it('records a provider_not_found evaluate with the matching outcome', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.evaluateAndApply({ providerId: 'missing', audit: AUDIT_ACTOR });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_evaluate_duration_seconds_count\{[^}]*outcome="provider_not_found"[^}]*\} 1/,
    );
    expect(out).not.toMatch(/provider_tier_transitions_total/);
  });

  it('records an applied override as a from/to/admin_override transition', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_1', status: 'active', tier: 'elite' }];
    const certs = buildCertifications(new Set());
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.overrideTier({
      providerId: 'prov_1',
      targetTier: 'basic',
      triggeredByUserId: 'user_ops',
      notes: 'pending complaint review',
      audit: AUDIT_ACTOR,
    });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_override_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_tier_transitions_total\{[^}]*from="elite"[^}]*to="basic"[^}]*reason="admin_override"[^}]*\} 1/,
    );
  });

  it('never leaks a providerId / actor id / note onto the scrape surface', async () => {
    const prisma = new FakePrisma();
    prisma.providers = [{ id: 'prov_secret_1', status: 'active', tier: 'basic' }];
    const certs = buildCertifications(new Set(['ccc']));
    const svc = new TierPromotionService(
      prisma as unknown as PrismaService,
      certs,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.evaluateAndApply({
      providerId: 'prov_secret_1',
      triggeredByUserId: 'user_secret_ops',
      audit: AUDIT_ACTOR,
    });

    const out = await serializeMetrics();
    expect(out).not.toContain('prov_secret_1');
    expect(out).not.toContain('user_secret_ops');
    expect(out).toMatch(/provider_tier_transitions_total/);
  });
});
