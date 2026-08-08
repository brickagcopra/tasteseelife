import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ok } from '../../../common/result';
import type { Env } from '../../../config/env';
import type {
  HouseholdTierSnapshotRecord,
  ProviderTierSnapshotRecord,
  TierGatingService,
} from '../services/tier-gating.service';
import { TierGatingController } from './tier-gating.controller';

/**
 * TierGatingController shared-secret + handler-wiring tests (TS-064).
 *
 * The behavioural surface area is small: each handler verifies the
 * shared-secret header, calls the service, and maps the result to the
 * response DTO. The first describe blocks cover:
 *
 *   - missing header → 401
 *   - wrong header value → 401
 *   - correct header → 200 + service called with the right args
 *   - sourceEventId pass-through
 *
 * A separate describe block at the bottom of the file pins the
 * tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout)
 * for each handler: the captured frame at the collaborator callsite must
 * be `{ kind: 'exempt', reason: 'internal-tier-snapshot-*-upsert' }`, and
 * the store must be empty before AND after the handler returns.
 */

const SECRET = 'x'.repeat(40);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
    BOOKING_TIER_GATING_MODE: 'enforce',
    BOOKING_TIER_DISPATCH_HEADER_NAME: HEADER,
    BOOKING_TIER_DISPATCH_API_KEY: SECRET,
    BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: HEADER,
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: SECRET,
  } as unknown as Env;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function fakeRequest(headerValue?: string): Request {
  return {
    header: (name: string): string | undefined => {
      if (name === HEADER) return headerValue;
      return undefined;
    },
  } as unknown as Request;
}

function buildController(): {
  controller: TierGatingController;
  service: {
    upsertHouseholdSnapshot: ReturnType<typeof vi.fn>;
    upsertProviderSnapshot: ReturnType<typeof vi.fn>;
  };
} {
  const householdRow: HouseholdTierSnapshotRecord = {
    householdId: 'hh_abc',
    tier: 'tier_2_companion',
    lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    sourceEventId: null,
    createdAt: new Date('2026-05-14T10:00:00.000Z'),
    updatedAt: new Date('2026-05-14T10:00:00.000Z'),
  };
  const providerRow: ProviderTierSnapshotRecord = {
    providerId: 'prv_xyz',
    tier: 'elite',
    lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
    sourceEventId: null,
    createdAt: new Date('2026-05-14T10:00:00.000Z'),
    updatedAt: new Date('2026-05-14T10:00:00.000Z'),
  };
  const service = {
    upsertHouseholdSnapshot: vi.fn(async () => ok(householdRow)),
    upsertProviderSnapshot: vi.fn(async () => ok(providerRow)),
  };
  const controller = new TierGatingController(
    service as unknown as TierGatingService,
    makeEnv(),
    makeStore(),
  );
  return { controller, service };
}

describe('TierGatingController.upsertHouseholdSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when the header is missing', async () => {
    const { controller } = buildController();
    await expect(
      controller.upsertHouseholdSnapshot(
        {
          householdId: 'hh_abc',
          tier: 'tier_2_companion',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        fakeRequest(undefined),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 when the header value is wrong (different length)', async () => {
    const { controller } = buildController();
    await expect(
      controller.upsertHouseholdSnapshot(
        {
          householdId: 'hh_abc',
          tier: 'tier_2_companion',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        fakeRequest('short'),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 when the header value is wrong (same length)', async () => {
    const { controller } = buildController();
    await expect(
      controller.upsertHouseholdSnapshot(
        {
          householdId: 'hh_abc',
          tier: 'tier_2_companion',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        fakeRequest('y'.repeat(40)),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('calls the service when the shared secret matches', async () => {
    const { controller, service } = buildController();
    const response = await controller.upsertHouseholdSnapshot(
      {
        householdId: 'hh_abc',
        tier: 'tier_3_concierge',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
        sourceEventId: 'evt_x',
      },
      fakeRequest(SECRET),
    );
    expect(service.upsertHouseholdSnapshot).toHaveBeenCalledTimes(1);
    expect(service.upsertHouseholdSnapshot).toHaveBeenCalledWith({
      householdId: 'hh_abc',
      tier: 'tier_3_concierge',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      sourceEventId: 'evt_x',
    });
    expect(response.householdId).toBe('hh_abc');
  });
});

describe('TierGatingController.upsertProviderSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when the header is missing', async () => {
    const { controller } = buildController();
    await expect(
      controller.upsertProviderSnapshot(
        {
          providerId: 'prv_xyz',
          tier: 'elite',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        fakeRequest(undefined),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('calls the service when the shared secret matches and forwards sourceEventId', async () => {
    const { controller, service } = buildController();
    await controller.upsertProviderSnapshot(
      {
        providerId: 'prv_xyz',
        tier: 'elite',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
        sourceEventId: 'evt_y',
      },
      fakeRequest(SECRET),
    );
    expect(service.upsertProviderSnapshot).toHaveBeenCalledWith({
      providerId: 'prv_xyz',
      tier: 'elite',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      sourceEventId: 'evt_y',
    });
  });

  it('omits sourceEventId from the call when not supplied', async () => {
    const { controller, service } = buildController();
    await controller.upsertProviderSnapshot(
      {
        providerId: 'prv_xyz',
        tier: 'certified',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
      },
      fakeRequest(SECRET),
    );
    const callArgs = service.upsertProviderSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('sourceEventId');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * Both endpoints on `TierGatingController` are Prisma-touching pre-auth
 * surfaces — they pin a shared-secret header instead of `AccessTokenGuard`,
 * so the `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream of these handlers
 * would hard-fail with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by constructing the controller with
 * a real `TenantContextStore`, passing a fake collaborator (the
 * `TierGatingService`) whose method captures `store.current()` at call
 * time, and asserting:
 *
 *   - the captured frame is `{ kind: 'exempt', reason: '<expected>' }`
 *     where `<expected>` matches the precise grep-able reason string
 *     the audit log will surface (one unique string per handler so a
 *     future log scan can trace every "no-context" Prisma access back
 *     to its dispatch source);
 *   - `store.current() === null` BEFORE and AFTER the handler call —
 *     the wrap leaves no frame behind (the `AsyncLocalStorage` `.run`
 *     scoping ensures this);
 *   - the 401 branch ALSO runs inside the same wrap (the
 *     `requireSharedSecret` private method's `request.header` read is
 *     itself inside the wrap, so we capture the frame on the header
 *     probe).
 *
 * Mirrors the canonical shape in `service-provider`'s
 * `ApplicationsController.receiveWebhookEvent` /
 * `ProviderDiscoveryController.getSnapshot` under TS-020-followup-2b.
 */
describe('TierGatingController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs upsertHouseholdSnapshot inside an exempt frame with reason "internal-tier-snapshot-household-upsert"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const householdRow: HouseholdTierSnapshotRecord = {
      householdId: 'hh_abc',
      tier: 'tier_2_companion',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      sourceEventId: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    };
    const fakeService = {
      upsertHouseholdSnapshot: vi.fn(async () => {
        captured = store.current();
        return ok(householdRow);
      }),
      upsertProviderSnapshot: vi.fn(),
    } as unknown as TierGatingService;
    const controller = new TierGatingController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await controller.upsertHouseholdSnapshot(
      {
        householdId: 'hh_abc',
        tier: 'tier_2_companion',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
      },
      fakeRequest(SECRET),
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-tier-snapshot-household-upsert',
    });
  });

  it('runs upsertHouseholdSnapshot 401 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The 401 short-circuit returns before any service call, so the
    // captured-frame probe lives on the `request.header` lookup — the
    // header read happens INSIDE the wrap.
    const request = {
      header: (name: string): string | undefined => {
        if (name === HEADER) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as Request;
    const fakeService = {
      upsertHouseholdSnapshot: vi.fn(),
      upsertProviderSnapshot: vi.fn(),
    } as unknown as TierGatingService;
    const controller = new TierGatingController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await expect(
      controller.upsertHouseholdSnapshot(
        {
          householdId: 'hh_abc',
          tier: 'tier_2_companion',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        request,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-tier-snapshot-household-upsert',
    });
  });

  it('runs upsertProviderSnapshot inside an exempt frame with reason "internal-tier-snapshot-provider-upsert"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const providerRow: ProviderTierSnapshotRecord = {
      providerId: 'prv_xyz',
      tier: 'elite',
      lastSyncedAt: new Date('2026-05-14T10:00:00.000Z'),
      sourceEventId: null,
      createdAt: new Date('2026-05-14T10:00:00.000Z'),
      updatedAt: new Date('2026-05-14T10:00:00.000Z'),
    };
    const fakeService = {
      upsertHouseholdSnapshot: vi.fn(),
      upsertProviderSnapshot: vi.fn(async () => {
        captured = store.current();
        return ok(providerRow);
      }),
    } as unknown as TierGatingService;
    const controller = new TierGatingController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await controller.upsertProviderSnapshot(
      {
        providerId: 'prv_xyz',
        tier: 'elite',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
      },
      fakeRequest(SECRET),
    );
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-tier-snapshot-provider-upsert',
    });
  });

  it('runs upsertProviderSnapshot 401 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const request = {
      header: (name: string): string | undefined => {
        if (name === HEADER) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as Request;
    const fakeService = {
      upsertHouseholdSnapshot: vi.fn(),
      upsertProviderSnapshot: vi.fn(),
    } as unknown as TierGatingService;
    const controller = new TierGatingController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await expect(
      controller.upsertProviderSnapshot(
        {
          providerId: 'prv_xyz',
          tier: 'elite',
          lastSyncedAt: '2026-05-14T10:00:00.000Z',
        },
        request,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-tier-snapshot-provider-upsert',
    });
  });
});
