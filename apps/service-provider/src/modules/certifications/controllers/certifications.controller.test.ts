import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  REQUIRE_PERMISSIONS_METADATA_KEY,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { CertificationCatalogRecord } from '../services/certifications-catalog.service';
import { CertificationsCatalogService } from '../services/certifications-catalog.service';
import {
  ProviderCertificationsService,
  type ProviderCertificationRow,
  type ProviderCertificationWithCatalog,
  type ProviderCertificationsFailure,
} from '../services/provider-certifications.service';
import { err, ok } from '../services/result';
import {
  TierPromotionService,
  type ProviderTierHistoryRow,
  type TierPromotionFailure,
} from '../services/tier-promotion.service';

import { CertificationsController, type ProviderProfileRow } from './certifications.controller';

const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
const NOW = new Date('2026-05-11T12:00:00.000Z');

const CATALOG_CCC: CertificationCatalogRecord = {
  id: 'cert_ccc',
  code: 'ccc',
  name: 'Certified Culinary Companion',
  description: 'Core academy credential.',
  issuer: 'Taste & See Cooking Academy',
  defaultValidityMonths: 24,
  sortPosition: 0,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const PROVIDER: ProviderProfileRow = {
  id: 'prov_1',
  status: 'active',
  tier: 'basic',
  displayName: 'Chef Sam',
  headline: null,
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  createdAt: NOW,
  updatedAt: NOW,
};

const ISSUANCE_ROW: ProviderCertificationRow = {
  id: 'pc_1',
  providerId: 'prov_1',
  certificationId: CATALOG_CCC.id,
  issuedAt: NOW,
  expiresAt: new Date('2028-05-11T12:00:00.000Z'),
  revokedAt: null,
  revocationReason: null,
  issuerUserId: 'user_ops',
  revokerUserId: null,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const ISSUANCE_WITH_CATALOG: ProviderCertificationWithCatalog = {
  row: ISSUANCE_ROW,
  catalog: CATALOG_CCC,
};

const HISTORY_ROW: ProviderTierHistoryRow = {
  id: 'th_1',
  providerId: 'prov_1',
  fromTier: 'basic',
  toTier: 'certified',
  reason: 'auto_evaluation',
  triggeredByUserId: 'user_ops',
  notes: null,
  occurredAt: NOW,
  createdAt: NOW,
};

interface FakePrismaShape {
  provider: {
    findUnique: ReturnType<typeof vi.fn>;
  };
}

function buildFakePrisma(rows: {
  byUserId?: ProviderProfileRow | null;
  byId?: ProviderProfileRow | null;
}): FakePrismaShape {
  return {
    provider: {
      findUnique: vi.fn(async (args: { where: { userId?: string; id?: string } }) => {
        if (args.where.userId !== undefined) {
          return rows.byUserId ?? null;
        }
        if (args.where.id !== undefined) {
          return rows.byId ?? null;
        }
        return null;
      }),
    },
  };
}

function buildCatalog(
  active: CertificationCatalogRecord[] = [CATALOG_CCC],
): CertificationsCatalogService {
  return {
    listActive: vi.fn(async () => active),
    findByCode: vi.fn(async (code: string) => active.find((c) => c.code === code) ?? null),
    findById: vi.fn(async (id: string) => active.find((c) => c.id === id) ?? null),
    findManyByIds: vi.fn(async (ids: readonly string[]) => {
      const map = new Map<string, CertificationCatalogRecord>();
      for (const c of active) {
        if (ids.includes(c.id)) map.set(c.id, c);
      }
      return map;
    }),
  } as unknown as CertificationsCatalogService;
}

interface ProviderCertsOverrides {
  grant?: ReturnType<typeof vi.fn>;
  revoke?: ReturnType<typeof vi.fn>;
  listForProvider?: ReturnType<typeof vi.fn>;
}

function buildProviderCerts(overrides: ProviderCertsOverrides = {}): ProviderCertificationsService {
  return {
    grant: overrides.grant ?? vi.fn(async () => ok(ISSUANCE_WITH_CATALOG)),
    revoke: overrides.revoke ?? vi.fn(async () => ok(ISSUANCE_WITH_CATALOG)),
    listForProvider:
      overrides.listForProvider ??
      vi.fn(async () => [ISSUANCE_WITH_CATALOG] as readonly ProviderCertificationWithCatalog[]),
    listActiveCodes: vi.fn(async () => new Set(['ccc'])),
  } as unknown as ProviderCertificationsService;
}

interface TierOverrides {
  evaluateAndApply?: ReturnType<typeof vi.fn>;
  overrideTier?: ReturnType<typeof vi.fn>;
  getHistory?: ReturnType<typeof vi.fn>;
}

function buildTier(overrides: TierOverrides = {}): TierPromotionService {
  return {
    evaluateAndApply:
      overrides.evaluateAndApply ??
      vi.fn(async () =>
        ok({
          provider: { id: 'prov_1', status: 'active', tier: 'certified' },
          previousTier: 'basic',
          nextTier: 'certified',
          applied: true,
          history: HISTORY_ROW,
        }),
      ),
    overrideTier:
      overrides.overrideTier ??
      vi.fn(async () =>
        ok({
          provider: { id: 'prov_1', status: 'active', tier: 'basic' },
          previousTier: 'certified',
          nextTier: 'basic',
          applied: true,
          history: { ...HISTORY_ROW, reason: 'admin_override' as const },
        }),
      ),
    getHistory: overrides.getHistory ?? vi.fn(async () => [HISTORY_ROW]),
  } as unknown as TierPromotionService;
}

function reqWithUser(userId = 'user_1'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    // TS-305a-followup-1 — buildAuditActorContext reads the request ip and
    // headers, so the fake has to carry them.
    ip: '203.0.113.9',
    headers: {},
    header: () => undefined,
  } as unknown as RequestWithContext;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function build(args: {
  prisma?: FakePrismaShape;
  catalog?: CertificationsCatalogService;
  providerCerts?: ProviderCertificationsService;
  tier?: TierPromotionService;
  store?: TenantContextStore;
}): CertificationsController {
  const prisma = (args.prisma ?? buildFakePrisma({})) as unknown as PrismaService;
  return new CertificationsController(
    args.catalog ?? buildCatalog(),
    args.providerCerts ?? buildProviderCerts(),
    args.tier ?? buildTier(),
    prisma,
    args.store ?? makeStore(),
  );
}

describe('CertificationsController idempotency wiring', () => {
  it('marks grant + revoke + tier-evaluate + tier-override as @Idempotent()', () => {
    const grant = CertificationsController.prototype.grantCertification as unknown as object;
    const revoke = CertificationsController.prototype.revokeCertification as unknown as object;
    const evaluate = CertificationsController.prototype.evaluateTier as unknown as object;
    const override = CertificationsController.prototype.overrideTier as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, grant)).toBe(true);
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, revoke)).toBe(true);
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, evaluate)).toBe(true);
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, override)).toBe(true);
  });

  it('does NOT mark the read endpoints as @Idempotent()', () => {
    const list = CertificationsController.prototype.listCatalog as unknown as object;
    const myProfile = CertificationsController.prototype.getMyProfile as unknown as object;
    const myCerts = CertificationsController.prototype.listMyCertifications as unknown as object;
    const history = CertificationsController.prototype.getTierHistory as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, list)).toBeUndefined();
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, myProfile)).toBeUndefined();
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, myCerts)).toBeUndefined();
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, history)).toBeUndefined();
  });
});

describe('CertificationsController RBAC metadata', () => {
  function getPermissions(method: keyof CertificationsController): readonly string[] | undefined {
    const handler = CertificationsController.prototype[method] as unknown as object;
    return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler) as
      | readonly string[]
      | undefined;
  }

  it('gates grant + revoke + tier-evaluate + tier-override + history on provider:approve', () => {
    expect(getPermissions('grantCertification')).toEqual(['provider:approve']);
    expect(getPermissions('revokeCertification')).toEqual(['provider:approve']);
    expect(getPermissions('evaluateTier')).toEqual(['provider:approve']);
    expect(getPermissions('overrideTier')).toEqual(['provider:approve']);
    expect(getPermissions('getTierHistory')).toEqual(['provider:approve']);
  });

  it('does NOT gate the public catalog + self-view endpoints', () => {
    expect(getPermissions('listCatalog')).toBeUndefined();
    expect(getPermissions('getMyProfile')).toBeUndefined();
    expect(getPermissions('listMyCertifications')).toBeUndefined();
  });
});

describe('CertificationsController.listCatalog', () => {
  it('returns the active catalog projected to DTOs', async () => {
    const controller = build({});
    const response = await controller.listCatalog();
    expect(response.certifications).toHaveLength(1);
    expect(response.certifications[0]?.code).toBe('ccc');
  });

  it('returns an empty list when the catalog is empty', async () => {
    const controller = build({ catalog: buildCatalog([]) });
    const response = await controller.listCatalog();
    expect(response.certifications).toEqual([]);
  });
});

describe('CertificationsController.getMyProfile', () => {
  it('returns provider + active certs when the user has a provider row', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byUserId: PROVIDER }),
    });
    const response = await controller.getMyProfile(reqWithUser());
    expect(response.provider?.id).toBe('prov_1');
    expect(response.activeCertifications).toHaveLength(1);
    expect(response.activeCertifications[0]?.certification.code).toBe('ccc');
  });

  it('returns null provider + empty certs when the user has no provider row', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byUserId: null }),
    });
    const response = await controller.getMyProfile(reqWithUser());
    expect(response.provider).toBeNull();
    expect(response.activeCertifications).toEqual([]);
  });

  it('throws 401 when requestContext is missing', async () => {
    const controller = build({});
    const req = {} as unknown as RequestWithContext;
    await expect(controller.getMyProfile(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CertificationsController.listMyCertifications', () => {
  it('returns the cert log for the authenticated provider', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byUserId: PROVIDER }),
    });
    const response = await controller.listMyCertifications(reqWithUser());
    expect(response.certifications).toHaveLength(1);
  });

  it('returns an empty list when the user has no provider row', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byUserId: null }),
    });
    const response = await controller.listMyCertifications(reqWithUser());
    expect(response.certifications).toEqual([]);
  });
});

describe('CertificationsController.grantCertification', () => {
  it('returns the wrapped issuance on success', async () => {
    const controller = build({});
    const response = await controller.grantCertification(
      'prov_1',
      { certificationCode: 'ccc' },
      reqWithUser('user_ops'),
    );
    expect(response.certification.id).toBe('pc_1');
    expect(response.certification.certification.code).toBe('ccc');
  });

  it('forwards the explicit null expiresAt to the service', async () => {
    const grant: ProviderCertificationsService['grant'] = vi.fn(async () =>
      ok(ISSUANCE_WITH_CATALOG),
    );
    const controller = build({
      providerCerts: buildProviderCerts({ grant: grant as unknown as ReturnType<typeof vi.fn> }),
    });
    await controller.grantCertification(
      'prov_1',
      { certificationCode: 'ccc', expiresAt: null },
      reqWithUser('user_ops'),
    );
    const mockGrant = grant as unknown as { mock: { calls: Array<[{ expiresAt: unknown }]> } };
    expect(mockGrant.mock.calls.length).toBeGreaterThan(0);
    expect(mockGrant.mock.calls[0]?.[0].expiresAt).toBeNull();
  });

  it('maps invalid_request to 400', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        grant: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'invalid_request',
            message: 'bad',
          }),
        ),
      }),
    });
    await expect(
      controller.grantCertification('prov_1', { certificationCode: 'ccc' }, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps provider_not_found to 404', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        grant: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'provider_not_found',
            providerId: 'prov_missing',
          }),
        ),
      }),
    });
    await expect(
      controller.grantCertification('prov_missing', { certificationCode: 'ccc' }, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps certification_not_found to 404', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        grant: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'certification_not_found',
            certificationCode: 'bogus',
          }),
        ),
      }),
    });
    await expect(
      controller.grantCertification('prov_1', { certificationCode: 'bogus' }, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps already_active to 409', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        grant: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'already_active',
            providerCertificationId: 'pc_existing',
          }),
        ),
      }),
    });
    await expect(
      controller.grantCertification('prov_1', { certificationCode: 'ccc' }, reqWithUser()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CertificationsController.revokeCertification', () => {
  it('returns the wrapped issuance on success', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        revoke: vi.fn(async () =>
          ok({
            row: { ...ISSUANCE_ROW, revokedAt: NOW, revocationReason: 'r' },
            catalog: CATALOG_CCC,
          }),
        ),
      }),
    });
    const response = await controller.revokeCertification(
      'prov_1',
      'pc_1',
      { reason: 'Performance complaint.' },
      reqWithUser('user_ops'),
    );
    expect(response.certification.revokedAt).not.toBeNull();
  });

  it('maps not_found to 404', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        revoke: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'not_found',
            providerCertificationId: 'pc_x',
          }),
        ),
      }),
    });
    await expect(
      controller.revokeCertification('prov_1', 'pc_x', { reason: 'r' }, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps already_revoked to 409', async () => {
    const controller = build({
      providerCerts: buildProviderCerts({
        revoke: vi.fn(async () =>
          err<ProviderCertificationsFailure>({
            reason: 'already_revoked',
            providerCertificationId: 'pc_x',
          }),
        ),
      }),
    });
    await expect(
      controller.revokeCertification('prov_1', 'pc_x', { reason: 'r' }, reqWithUser()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CertificationsController.evaluateTier', () => {
  it('returns provider + transition history on apply', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byId: { ...PROVIDER, tier: 'certified' } }),
    });
    const response = await controller.evaluateTier('prov_1', reqWithUser('user_ops'));
    expect(response.provider.tier).toBe('certified');
    expect(response.applied).toBe(true);
    expect(response.history?.toTier).toBe('certified');
  });

  it('returns applied=false history=null on a no-op evaluation', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byId: { ...PROVIDER, tier: 'certified' } }),
      tier: buildTier({
        evaluateAndApply: vi.fn(async () =>
          ok({
            provider: { id: 'prov_1', status: 'active', tier: 'certified' },
            previousTier: 'certified',
            nextTier: 'certified',
            applied: false,
            history: null,
          }),
        ),
      }),
    });
    const response = await controller.evaluateTier('prov_1', reqWithUser('user_ops'));
    expect(response.applied).toBe(false);
    expect(response.history).toBeNull();
  });

  it('maps provider_not_found to 404', async () => {
    const controller = build({
      tier: buildTier({
        evaluateAndApply: vi.fn(async () =>
          err<TierPromotionFailure>({
            reason: 'provider_not_found',
            providerId: 'prov_missing',
          }),
        ),
      }),
    });
    await expect(controller.evaluateTier('prov_missing', reqWithUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps invalid_request to 400', async () => {
    const controller = build({
      tier: buildTier({
        evaluateAndApply: vi.fn(async () =>
          err<TierPromotionFailure>({
            reason: 'invalid_request',
            message: 'bad',
          }),
        ),
      }),
    });
    await expect(controller.evaluateTier('', reqWithUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('CertificationsController.overrideTier', () => {
  it('returns provider + admin_override history on apply', async () => {
    const controller = build({
      prisma: buildFakePrisma({ byId: { ...PROVIDER, tier: 'basic' } }),
    });
    const response = await controller.overrideTier(
      'prov_1',
      { targetTier: 'basic', notes: 'Demote pending complaint review.' },
      reqWithUser('user_ops'),
    );
    expect(response.applied).toBe(true);
    expect(response.history?.reason).toBe('admin_override');
  });
});

describe('CertificationsController.getTierHistory', () => {
  it('returns the transition log', async () => {
    const controller = build({});
    const response = await controller.getTierHistory('prov_1');
    expect(response.history).toHaveLength(1);
    expect(response.history[0]?.toTier).toBe('certified');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `CertificationsController.listCatalog` is the only Prisma-touching
 * pre-auth surface in this controller. The endpoint is anonymous by
 * design (provider portal + marketing site render it to
 * unauthenticated visitors), so the `TenantContextInterceptor` cannot
 * seed a scoped frame from a `request.requestContext` that does not
 * exist. Without an explicit exempt wrap, every Prisma operation
 * downstream of this handler would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * The `Certification` model is also marked `unscoped` in
 * `TenantContextModule.forRoot`'s `unscopedModels` list (the catalog
 * has no tenant axis), so the gate would short-circuit before
 * consulting the frame. The wrap is the belt-and-braces defense in
 * case a future read here touches a scoped model (e.g. joining
 * against a per-provider issuance count).
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake catalog service that captures
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'pre-auth-certifications-list' }` — the
 * precise reason string the audit log will surface, so a future log
 * scan can trace every "no-context" Prisma access back to its
 * pre-auth source. Mirrors the canonical shape in the
 * `PlansController` wrap landed under TS-020-followup-2b-platform-rollout's
 * `service-subscription` sibling.
 */
describe('CertificationsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs listCatalog inside an exempt frame with reason "pre-auth-certifications-list"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const catalog = {
      listActive: vi.fn(async () => {
        captured = store.current();
        return [CATALOG_CCC];
      }),
      findByCode: vi.fn(),
      findById: vi.fn(),
      findManyByIds: vi.fn(),
    } as unknown as CertificationsCatalogService;

    const controller = build({ catalog, store });

    expect(store.current()).toBeNull();
    const response = await controller.listCatalog();
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'pre-auth-certifications-list',
    });
    expect(response.certifications).toHaveLength(1);
    expect(response.certifications[0]?.code).toBe('ccc');
  });

  it('captures the frame even when the service throws (wrap survives the error path)', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const catalog = {
      listActive: vi.fn(async () => {
        captured = store.current();
        throw new Error('postgres unreachable');
      }),
      findByCode: vi.fn(),
      findById: vi.fn(),
      findManyByIds: vi.fn(),
    } as unknown as CertificationsCatalogService;

    const controller = build({ catalog, store });

    await expect(controller.listCatalog()).rejects.toThrow('postgres unreachable');

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'pre-auth-certifications-list',
    });
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const controller = build({ store });

    expect(store.current()).toBeNull();
    await controller.listCatalog();
    expect(store.current()).toBeNull();
  });
});
