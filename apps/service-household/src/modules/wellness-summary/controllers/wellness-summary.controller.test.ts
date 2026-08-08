import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { InternalWellnessSummaryHouseholdsResponse } from '@taste-and-see/contracts';
import { InternalWellnessSummaryHouseholdsQuerySchema } from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { WellnessSummaryService } from '../services/wellness-summary.service';
import { WellnessSummaryInternalController } from './wellness-summary.controller';

/**
 * WellnessSummaryInternalController behavioural tests (TS-235).
 *
 * Areas:
 *   - shared-secret enforcement — missing header → 401, wrong value
 *     → 401, same-length-different-bytes → 401, correct value → service
 *     called and the parsed response returns.
 *   - query validation — the `ZodValidationPipe` rejects a bad limit and
 *     accepts/coerces a valid one (exercised directly against the schema,
 *     the same pipe wired on the handler).
 *   - tenant-scope exempt wrap — the handler runs under the
 *     `internal-wellness-summary-households` exempt frame and the store
 *     is empty before AND after.
 */

const SECRET = 'w'.repeat(48);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: HEADER,
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: SECRET,
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

function samplePage(): InternalWellnessSummaryHouseholdsResponse {
  return {
    households: [
      {
        householdId: 'hh_1',
        seniors: [{ seniorId: 'sn_1', firstName: 'Anna', status: 'active', notesConsent: true }],
        recipients: [{ userId: 'usr_1', role: 'primary_payer' }],
      },
    ],
    nextCursor: 'hh_1',
  };
}

function buildController(page: InternalWellnessSummaryHouseholdsResponse = samplePage()): {
  controller: WellnessSummaryInternalController;
  service: { listHouseholds: ReturnType<typeof vi.fn> };
  store: TenantContextStore;
} {
  const service = { listHouseholds: vi.fn(async () => page) };
  const store = makeStore();
  const controller = new WellnessSummaryInternalController(
    service as unknown as WellnessSummaryService,
    makeEnv(),
    store,
  );
  return { controller, service, store };
}

describe('WellnessSummaryInternalController.listHouseholds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when the header is missing', async () => {
    const { controller, service } = buildController();
    await expect(controller.listHouseholds({ limit: 100 }, fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.listHouseholds).not.toHaveBeenCalled();
  });

  it('returns 401 when the header value is wrong', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.listHouseholds({ limit: 100 }, fakeRequest('totally-wrong-value')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.listHouseholds).not.toHaveBeenCalled();
  });

  it('returns 401 when a header value is presented with the same length but different bytes', async () => {
    const { controller, service } = buildController();
    const wrongSameLength = 'z'.repeat(SECRET.length);
    await expect(
      controller.listHouseholds({ limit: 100 }, fakeRequest(wrongSameLength)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.listHouseholds).not.toHaveBeenCalled();
  });

  it('forwards the query to the service and returns the parsed page when authorised', async () => {
    const { controller, service } = buildController();
    const response = await controller.listHouseholds(
      { limit: 50, cursor: 'hh_prev' },
      fakeRequest(SECRET),
    );
    expect(service.listHouseholds).toHaveBeenCalledOnce();
    expect(service.listHouseholds).toHaveBeenCalledWith({ limit: 50, cursor: 'hh_prev' });
    expect(response.households).toHaveLength(1);
    expect(response.nextCursor).toBe('hh_1');
  });

  it('passes an undefined cursor through to the service on the first page', async () => {
    const { controller, service } = buildController();
    await controller.listHouseholds({ limit: 100 }, fakeRequest(SECRET));
    expect(service.listHouseholds).toHaveBeenCalledWith({ limit: 100, cursor: undefined });
  });
});

describe('WellnessSummaryInternalController query validation (ZodValidationPipe)', () => {
  // The handler is decorated with
  // `@Query(new ZodValidationPipe(InternalWellnessSummaryHouseholdsQuerySchema))`.
  // Exercise that pipe directly — it is the same instance wired on the
  // route, so its behaviour is the controller's validation contract.
  const pipe = new ZodValidationPipe(InternalWellnessSummaryHouseholdsQuerySchema);

  it('defaults limit to 100 when omitted', () => {
    expect(pipe.transform({})).toEqual({ limit: 100 });
  });

  it('coerces a numeric-string limit', () => {
    expect(pipe.transform({ limit: '250' })).toEqual({ limit: 250 });
  });

  it('rejects a limit above the max', () => {
    expect(() => pipe.transform({ limit: '501' })).toThrow(BadRequestException);
  });

  it('rejects a non-positive limit', () => {
    expect(() => pipe.transform({ limit: '0' })).toThrow(BadRequestException);
  });

  it('rejects an unknown query field (strict schema)', () => {
    expect(() => pipe.transform({ limit: '10', bogus: 'x' })).toThrow(BadRequestException);
  });

  it('accepts a cursor + limit pair', () => {
    expect(pipe.transform({ cursor: 'hh_abc', limit: '20' })).toEqual({
      cursor: 'hh_abc',
      limit: 20,
    });
  });
});

describe('WellnessSummaryInternalController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs the handler under an exempt frame keyed `internal-wellness-summary-households`', async () => {
    const page = samplePage();
    let frameAtCallsite: unknown = 'unset';
    const service = {
      listHouseholds: vi.fn(async () => {
        frameAtCallsite = store.current();
        return page;
      }),
    };
    const store = makeStore();
    const controller = new WellnessSummaryInternalController(
      service as unknown as WellnessSummaryService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.listHouseholds({ limit: 100 }, fakeRequest(SECRET));
    expect(store.current()).toBeNull();

    expect(frameAtCallsite).toEqual({
      kind: 'exempt',
      reason: 'internal-wellness-summary-households',
    });
  });

  it('keeps the frame exempt even on the 401 short-circuit', async () => {
    const service = { listHouseholds: vi.fn() };
    const store = makeStore();
    const controller = new WellnessSummaryInternalController(
      service as unknown as WellnessSummaryService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    // The requireSharedSecret call lives INSIDE the runWithoutTenantContext
    // closure, so the wrap is in place even when the secret check rejects.
    await expect(controller.listHouseholds({ limit: 100 }, fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.current()).toBeNull();
  });
});
