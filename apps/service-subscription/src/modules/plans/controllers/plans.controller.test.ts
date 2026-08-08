import type { Plan } from '@taste-and-see/contracts';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { PlansService } from '../services/plans.service';
import { PlansController } from './plans.controller';

/**
 * The PlansController test file has two describe-block surfaces:
 *
 *   1. `PlansController.list` — happy-path behavioural coverage
 *      (envelope shape, empty catalog, ordering pass-through, error
 *      passthrough). These tests pre-date the tenant-scope SDK rollout
 *      and pin the contract a marketing-site consumer renders.
 *
 *   2. `PlansController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)`
 *      — the wrap contract introduced by the platform rollout. The
 *      handler runs before any `requestContext` exists, so the body is
 *      wrapped in `runWithoutTenantContext(...)` with reason
 *      `'pre-auth-plans-list'`. These tests pin the wrap by passing a
 *      real `TenantContextStore` and capturing `store.current()` at the
 *      collaborator's callsite.
 */

function buildPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_essential',
    code: 'family.tier1',
    name: 'Essential',
    description: 'Base mass-market membership.',
    customerGroup: 'family',
    monthlyPriceUsdMinor: 2900,
    annualPriceUsdMinor: 29000,
    currency: 'USD',
    features: ['App access'],
    active: true,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

describe('PlansController.list', () => {
  it('returns the plans wrapped in a `{ plans: [...] }` envelope', async () => {
    const plans = [buildPlan()];
    const service = {
      listActive: vi.fn().mockResolvedValue(plans),
    } as unknown as PlansService;
    const controller = new PlansController(service, makeStore());

    const response = await controller.list();
    expect(response).toEqual({ plans });
  });

  it('returns an empty plans array when the catalog is empty', async () => {
    const service = {
      listActive: vi.fn().mockResolvedValue([]),
    } as unknown as PlansService;
    const controller = new PlansController(service, makeStore());

    const response = await controller.list();
    expect(response).toEqual({ plans: [] });
  });

  it('delegates ordering to the service (no controller-side resort)', async () => {
    // The controller MUST NOT re-order the service's output — the service
    // owns the ordering contract so a future order-policy change is a
    // one-place edit, not a "did we remember to also fix the controller"
    // regression.
    const ordered = [
      buildPlan({ id: 'p1', code: 'academy.membership', customerGroup: 'academy' }),
      buildPlan({ id: 'p2', code: 'family.tier1', customerGroup: 'family' }),
      buildPlan({ id: 'p3', code: 'provider.basic', customerGroup: 'provider' }),
    ];
    const service = {
      listActive: vi.fn().mockResolvedValue(ordered),
    } as unknown as PlansService;
    const controller = new PlansController(service, makeStore());

    const response = await controller.list();
    expect(response.plans.map((p) => p.code)).toEqual([
      'academy.membership',
      'family.tier1',
      'provider.basic',
    ]);
  });

  it('passes through service errors (no swallowing)', async () => {
    const service = {
      listActive: vi.fn().mockRejectedValue(new Error('postgres unreachable')),
    } as unknown as PlansService;
    const controller = new PlansController(service, makeStore());

    await expect(controller.list()).rejects.toThrow('postgres unreachable');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `PlansController.list` is the only Prisma-touching pre-auth surface
 * in service-subscription. The endpoint is anonymous by design (the
 * public pricing page renders it to unauthenticated visitors), so the
 * `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream of this handler would
 * hard-fail with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake `PlansService` that captures
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'pre-auth-plans-list' }` — the precise
 * reason string the audit log will surface, so a future log scan can
 * trace every "no-context" Prisma access back to its pre-auth source.
 *
 * The captured frame also acts as the implicit assertion that the
 * service is invoked INSIDE the wrap's lexical scope. A regression that
 * pulled a Prisma call outside the wrap (e.g. by hoisting the
 * `listActive` call into a memoised getter computed outside the wrap)
 * would surface here as `frame === null`.
 */
describe('PlansController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs list inside an exempt frame with reason "pre-auth-plans-list"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const listActiveMock = vi.fn(async () => {
      captured = store.current();
      return [buildPlan()];
    });
    const service = { listActive: listActiveMock } as unknown as PlansService;
    const controller = new PlansController(service, store);

    await controller.list();

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-plans-list' });
    expect(listActiveMock).toHaveBeenCalledTimes(1);
  });

  it('captures the frame even when the service throws (wrap survives the error path)', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const listActiveMock = vi.fn(async () => {
      captured = store.current();
      throw new Error('postgres unreachable');
    });
    const service = { listActive: listActiveMock } as unknown as PlansService;
    const controller = new PlansController(service, store);

    await expect(controller.list()).rejects.toThrow('postgres unreachable');

    // The frame was visible at the failing collaborator's callsite even
    // though the wrap rethrows — proving the wrap doesn't swallow errors
    // and the exempt frame applies to the entire handler body.
    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-plans-list' });
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const service = {
      listActive: vi.fn().mockResolvedValue([buildPlan()]),
    } as unknown as PlansService;
    const controller = new PlansController(service, store);

    expect(store.current()).toBeNull();
    await controller.list();
    expect(store.current()).toBeNull();
  });
});
