import type { OutboxService } from '@taste-and-see/nest-outbox';
import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuditActorContext, type AuditEmitter } from '@taste-and-see/nest-audit';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  CertificationsCatalogService,
  type CertificationCatalogRecord,
} from './certifications-catalog.service';
import { CertificationsMetrics } from './certifications-metrics';
import {
  ProviderCertificationsService,
  type ProviderCertificationRow,
} from './provider-certifications.service';

/**
 * Minimal `OutboxService` stand-in for unit tests. Records the
 * `append` calls so individual tests can assert event emission, and
 * by default returns `{kind: 'appended'}` so the service's happy
 * path proceeds. Override `overrideAppendBehavior` in a test to
 * simulate a validation failure and exercise the rollback path.
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

interface FakeProviderRow {
  id: string;
}

class FakePrisma {
  public providers: FakeProviderRow[] = [];
  public certs: ProviderCertificationRow[] = [];
  private autoId = 0;

  provider = {
    findUnique: vi.fn(async (args: { where: { id: string }; select: { id: true } }) => {
      const row = this.providers.find((p) => p.id === args.where.id);
      return row === undefined ? null : { id: row.id };
    }),
  };

  providerCertification = {
    findFirst: vi.fn(
      async (args: {
        where: { providerId: string; certificationId: string; revokedAt: null };
      }): Promise<ProviderCertificationRow | null> => {
        return (
          this.certs.find(
            (c) =>
              c.providerId === args.where.providerId &&
              c.certificationId === args.where.certificationId &&
              c.revokedAt === null,
          ) ?? null
        );
      },
    ),
    findUnique: vi.fn(
      async (args: { where: { id: string } }): Promise<ProviderCertificationRow | null> => {
        return this.certs.find((c) => c.id === args.where.id) ?? null;
      },
    ),
    findMany: vi.fn(
      async (args: {
        where: {
          providerId: string;
          revokedAt?: null;
          OR?: ReadonlyArray<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
        };
      }): Promise<ProviderCertificationRow[]> => {
        const now = ((): Date | null => {
          const or = args.where.OR;
          if (or === undefined) return null;
          for (const clause of or) {
            if ('expiresAt' in clause && clause.expiresAt !== null) {
              return clause.expiresAt.gt;
            }
          }
          return null;
        })();

        let filtered = this.certs.filter((c) => c.providerId === args.where.providerId);
        if (args.where.revokedAt === null) {
          filtered = filtered.filter((c) => c.revokedAt === null);
        }
        if (now !== null) {
          filtered = filtered.filter(
            (c) => c.expiresAt === null || c.expiresAt.getTime() > now.getTime(),
          );
        }
        filtered.sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
        return filtered;
      },
    ),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      this.autoId += 1;
      const row: ProviderCertificationRow = {
        id: `pc_${this.autoId}`,
        providerId: args.data['providerId'] as string,
        certificationId: args.data['certificationId'] as string,
        issuedAt: args.data['issuedAt'] as Date,
        expiresAt: (args.data['expiresAt'] as Date | undefined) ?? null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: (args.data['issuerUserId'] as string | undefined) ?? null,
        revokerUserId: null,
        notes: (args.data['notes'] as string | undefined) ?? null,
        createdAt: new Date('2026-05-11T00:00:00.000Z'),
        updatedAt: new Date('2026-05-11T00:00:00.000Z'),
      };
      this.certs.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const idx = this.certs.findIndex((c) => c.id === args.where.id);
      if (idx === -1) throw new Error('cert row missing in fake');
      const target = this.certs[idx];
      if (target === undefined) throw new Error('cert row missing in fake');
      const next: ProviderCertificationRow = { ...target };
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        (next as unknown as Record<string, unknown>)[key] = value;
      }
      (next as { updatedAt: Date }).updatedAt = new Date('2026-05-11T01:00:00.000Z');
      this.certs[idx] = next;
      return next;
    }),
  };

  /**
   * Minimal `$transaction` that runs the callback against the same
   * delegates the top-level client exposes. This fake does NOT roll
   * back partial writes on error — the integration test
   * (TS-052-followup-8) is the authoritative round-trip check
   * against a real Postgres. Unit tests inspect the returned
   * `Result` shape rather than the post-error array state.
   */
  $transaction = vi.fn(
    async <T>(
      fn: (tx: {
        provider: FakePrisma['provider'];
        providerCertification: FakePrisma['providerCertification'];
      }) => Promise<T>,
    ): Promise<T> => {
      return fn({
        provider: this.provider,
        providerCertification: this.providerCertification,
      });
    },
  );
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

const CATALOG_CCC: CertificationCatalogRecord = {
  id: 'cert_ccc',
  code: 'ccc',
  name: 'Certified Culinary Companion',
  description: 'Core academy credential.',
  issuer: 'Taste & See Cooking Academy',
  defaultValidityMonths: 24,
  sortPosition: 0,
  active: true,
  createdAt: new Date('2026-05-11T00:00:00.000Z'),
  updatedAt: new Date('2026-05-11T00:00:00.000Z'),
};

const CATALOG_DEMENTIA: CertificationCatalogRecord = {
  id: 'cert_dementia',
  code: 'dementia_sensitive',
  name: 'Dementia-Sensitive Dining',
  description: 'Specialty.',
  issuer: 'Taste & See Cooking Academy',
  defaultValidityMonths: null,
  sortPosition: 2,
  active: true,
  createdAt: new Date('2026-05-11T00:00:00.000Z'),
  updatedAt: new Date('2026-05-11T00:00:00.000Z'),
};

function buildCatalog(
  map: Record<string, CertificationCatalogRecord>,
): CertificationsCatalogService {
  return {
    findByCode: vi.fn(async (code: string) => map[code] ?? null),
    findById: vi.fn(async (id: string) => {
      for (const row of Object.values(map)) {
        if (row.id === id) return row;
      }
      return null;
    }),
    findManyByIds: vi.fn(async (ids: readonly string[]) => {
      const result = new Map<string, CertificationCatalogRecord>();
      for (const row of Object.values(map)) {
        if (ids.includes(row.id)) result.set(row.id, row);
      }
      return result;
    }),
    listActive: vi.fn(async () => Object.values(map).filter((r) => r.active)),
  } as unknown as CertificationsCatalogService;
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

describe('ProviderCertificationsService.grant', () => {
  it('grants a fresh certification with catalog-default expiry', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const issuedAt = new Date('2026-05-11T12:00:00.000Z');
    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      issuedAt,
      issuerUserId: 'user_ops',
      notes: 'graduate of fall cohort',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.providerId).toBe('prov_1');
    expect(result.value.row.certificationId).toBe(CATALOG_CCC.id);
    expect(result.value.row.notes).toBe('graduate of fall cohort');
    // 24 months added → 2028-05-11
    expect(result.value.row.expiresAt?.toISOString()).toBe('2028-05-11T12:00:00.000Z');
  });

  it('grants with null expiry when catalog has no default and override is undefined', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ dementia_sensitive: CATALOG_DEMENTIA });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'dementia_sensitive',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.expiresAt).toBeNull();
  });

  it('grants with null expiry when override explicitly is null (overrides catalog default)', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      expiresAt: null,
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.expiresAt).toBeNull();
  });

  it('grants with explicit expiry override', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const issuedAt = new Date('2026-05-11T12:00:00.000Z');
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      issuedAt,
      expiresAt,
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects an empty providerId', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: '',
      certificationCode: 'ccc',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects an empty certificationCode', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({});
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: '',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
  });

  it('fails when the provider does not exist', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_missing',
      certificationCode: 'ccc',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('provider_not_found');
  });

  it('fails when the certification code is unknown / inactive', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({});
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'bogus',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('certification_not_found');
  });

  it('rejects a second active grant on the same (provider, cert) pair', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    prisma.certs = [
      {
        id: 'pc_existing',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2028-01-01T00:00:00.000Z'),
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      audit: AUDIT_ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('already_active');
  });

  it('auto-revokes a stale-expired existing row and grants a fresh one', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    prisma.certs = [
      {
        id: 'pc_expired',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      issuedAt: new Date('2026-05-11T12:00:00.000Z'),
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.id).not.toBe('pc_expired');
    // The stale row should be revoked now.
    const stale = prisma.certs.find((c) => c.id === 'pc_expired');
    expect(stale?.revokedAt).not.toBeNull();
    expect(stale?.revocationReason).toContain('auto-revoked');
  });

  it('emits provider.certification_granted via the outbox on success', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const outbox = buildFakeOutbox();
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      issuedAt: new Date('2026-05-11T12:00:00.000Z'),
      issuerUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe('provider.certification_granted');
    expect(call?.eventId).toBe(`${result.value.row.id}.granted`);
    const payload = call?.payload as Record<string, unknown> | undefined;
    expect(payload?.['providerId']).toBe('prov_1');
    expect(payload?.['providerCertificationId']).toBe(result.value.row.id);
    expect(payload?.['certificationCode']).toBe('ccc');
    expect(payload?.['issuerUserId']).toBe('user_ops');
    expect(typeof payload?.['issuedAt']).toBe('string');
    expect(typeof payload?.['expiresAt']).toBe('string');
  });

  it('surfaces outbox_validation_failed and aborts the transaction on payload rejection', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('payload missing field');
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe('provider.certification_granted');
  });
});

describe('ProviderCertificationsService.revoke', () => {
  it('revokes an active row', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_1',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_1',
      providerId: 'prov_1',
      reason: 'Performance complaint.',
      revokerUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.revokedAt).not.toBeNull();
    expect(result.value.row.revocationReason).toBe('Performance complaint.');
    expect(result.value.row.revokerUserId).toBe('user_ops');
  });

  it('rejects empty providerCertificationId / providerId / reason', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    expect(
      (
        await svc.revoke({
          providerCertificationId: '',
          providerId: 'p',
          reason: 'r',
          audit: AUDIT_ACTOR,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await svc.revoke({
          providerCertificationId: 'p',
          providerId: '',
          reason: 'r',
          audit: AUDIT_ACTOR,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await svc.revoke({
          providerCertificationId: 'p',
          providerId: 'p',
          reason: '',
          audit: AUDIT_ACTOR,
        })
      ).ok,
    ).toBe(false);
  });

  it('returns not_found when the id is unknown', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_missing',
      providerId: 'prov_1',
      reason: 'r',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns not_found when the row belongs to a different provider', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_other',
        providerId: 'prov_other',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_other',
      providerId: 'prov_self',
      reason: 'r',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns already_revoked when revoked', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_done',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date(),
        expiresAt: null,
        revokedAt: new Date(),
        revocationReason: 'earlier',
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_done',
      providerId: 'prov_1',
      reason: 'redoing',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('already_revoked');
  });

  it('emits provider.certification_revoked via the outbox on success', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_active',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const outbox = buildFakeOutbox();
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_active',
      providerId: 'prov_1',
      reason: 'Performance complaint.',
      revokerUserId: 'user_ops',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe('provider.certification_revoked');
    expect(call?.eventId).toBe('pc_active.revoked');
    const payload = call?.payload as Record<string, unknown> | undefined;
    expect(payload?.['providerId']).toBe('prov_1');
    expect(payload?.['providerCertificationId']).toBe('pc_active');
    expect(payload?.['certificationCode']).toBe('ccc');
    expect(payload?.['revocationReason']).toBe('Performance complaint.');
    expect(payload?.['revokerUserId']).toBe('user_ops');
  });

  it('surfaces outbox_validation_failed and aborts the transaction on revoke payload rejection', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_active',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('bad payload');
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(outbox),
      buildFakeAudit(),
    );

    const result = await svc.revoke({
      providerCertificationId: 'pc_active',
      providerId: 'prov_1',
      reason: 'r',
      audit: AUDIT_ACTOR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
  });
});

describe('ProviderCertificationsService.listForProvider', () => {
  it('returns rows newest-first joined with catalog', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_old',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pc_new',
        providerId: 'prov_1',
        certificationId: CATALOG_DEMENTIA.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({
      ccc: CATALOG_CCC,
      dementia_sensitive: CATALOG_DEMENTIA,
    });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const list = await svc.listForProvider('prov_1');

    expect(list.map((l) => l.row.id)).toEqual(['pc_new', 'pc_old']);
    expect(list[0]?.catalog.code).toBe('dementia_sensitive');
  });

  it('respects activeOnly by filtering revoked / expired rows', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_revoked',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: new Date('2025-06-01T00:00:00.000Z'),
        revocationReason: 'x',
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pc_expired',
        providerId: 'prov_1',
        certificationId: CATALOG_DEMENTIA.id,
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pc_active',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2028-01-01T00:00:00.000Z'),
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({
      ccc: CATALOG_CCC,
      dementia_sensitive: CATALOG_DEMENTIA,
    });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const list = await svc.listForProvider('prov_1', {
      activeOnly: true,
      now: new Date('2026-05-11T00:00:00.000Z'),
    });

    expect(list.map((l) => l.row.id)).toEqual(['pc_active']);
  });

  it('returns an empty list for an empty providerId without hitting Prisma', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({});
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const list = await svc.listForProvider('');

    expect(list).toEqual([]);
    expect(prisma.providerCertification.findMany).not.toHaveBeenCalled();
  });
});

describe('ProviderCertificationsService.listActiveCodes', () => {
  it('projects active codes only', async () => {
    const prisma = buildPrisma();
    prisma.certs = [
      {
        id: 'pc_active',
        providerId: 'prov_1',
        certificationId: CATALOG_CCC.id,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pc_revoked',
        providerId: 'prov_1',
        certificationId: CATALOG_DEMENTIA.id,
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: new Date('2025-06-01T00:00:00.000Z'),
        revocationReason: 'x',
        issuerUserId: null,
        revokerUserId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const catalog = buildCatalog({
      ccc: CATALOG_CCC,
      dementia_sensitive: CATALOG_DEMENTIA,
    });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const codes = await svc.listActiveCodes('prov_1');

    expect([...codes]).toEqual(['ccc']);
  });

  it('returns an empty set for a user without certifications', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({});
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
    );

    const codes = await svc.listActiveCodes('prov_1');
    expect(codes.size).toBe(0);
  });
});

/**
 * Observability wiring (TS-052-followup-9). A real MeterProvider is booted
 * so the `CertificationsMetrics` passed here binds to the live meter; the
 * service drives each outcome end-to-end and the Prometheus exposition is
 * asserted. Mirrors the ApplicationsService observability block.
 */
describe('ProviderCertificationsService — observability', () => {
  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a successful grant as outcome="ok" with a latency sample', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.grant({ providerId: 'prov_1', certificationCode: 'ccc', audit: AUDIT_ACTOR });

    const out = await serializeMetrics();
    expect(out).toMatch(/provider_certifications_granted_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /provider_certification_grant_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a provider_not_found grant with the matching outcome', async () => {
    const prisma = buildPrisma();
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.grant({ providerId: 'missing', certificationCode: 'ccc', audit: AUDIT_ACTOR });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_certifications_granted_total\{[^}]*outcome="provider_not_found"[^}]*\} 1/,
    );
  });

  it('counts a successful revoke as outcome="ok"', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    const granted = await svc.grant({
      providerId: 'prov_1',
      certificationCode: 'ccc',
      audit: AUDIT_ACTOR,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    await svc.revoke({
      providerCertificationId: granted.value.row.id,
      providerId: 'prov_1',
      reason: 'left the platform',
      audit: AUDIT_ACTOR,
    });

    const out = await serializeMetrics();
    expect(out).toMatch(/provider_certifications_revoked_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /provider_certification_revoke_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('never leaks a providerId / actor id onto the scrape surface', async () => {
    const prisma = buildPrisma();
    prisma.providers = [{ id: 'prov_secret_1' }];
    const catalog = buildCatalog({ ccc: CATALOG_CCC });
    const svc = new ProviderCertificationsService(
      prisma as unknown as PrismaService,
      catalog,
      asOutboxService(buildFakeOutbox()),
      buildFakeAudit(),
      new CertificationsMetrics(),
    );

    await svc.grant({
      providerId: 'prov_secret_1',
      certificationCode: 'ccc',
      issuerUserId: 'user_secret_ops',
      audit: AUDIT_ACTOR,
    });

    const out = await serializeMetrics();
    expect(out).not.toContain('prov_secret_1');
    expect(out).not.toContain('user_secret_ops');
    expect(out).toMatch(/provider_certifications_granted_total/);
  });
});
