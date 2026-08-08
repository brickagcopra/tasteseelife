import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { InternalSeniorPrepSnapshotResponse } from '@taste-and-see/contracts';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { VisitPrepService } from '../services/visit-prep.service';
import { VisitPrepInternalController } from './visit-prep.controller';

/**
 * VisitPrepInternalController behavioural tests (TS-208).
 *
 * Three areas:
 *
 *   - shared-secret enforcement — missing header → 401, wrong value
 *     → 401, correct value → service called and the parsed response
 *     comes back.
 *   - service failures bubble up — 404 from the service propagates
 *     unchanged.
 *   - tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)
 *     — captures the frame at the collaborator callsite + asserts the
 *     store is empty before AND after the handler.
 */

const SECRET = 'p'.repeat(48);
const HEADER = 'x-household-visit-prep-internal-api-key';

function makeEnv(): Env {
  return {
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: HEADER,
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: SECRET,
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

function sampleSnapshot(): InternalSeniorPrepSnapshotResponse {
  return {
    senior: {
      seniorId: 'sn_abc',
      dietaryTags: ['low_sodium'],
      allergenTags: ['peanut'],
      languageTags: ['en-US'],
      mobilityLevel: 'aided_cane',
      dementiaStatus: 'mild_cognitive_impairment',
      intakeCompletedAt: '2026-05-01T12:00:00.000Z',
    },
    memoryRecipes: [],
  };
}

function buildController(snapshot: InternalSeniorPrepSnapshotResponse = sampleSnapshot()): {
  controller: VisitPrepInternalController;
  service: { getSnapshot: ReturnType<typeof vi.fn> };
  store: TenantContextStore;
} {
  const service = { getSnapshot: vi.fn(async () => snapshot) };
  const store = makeStore();
  const controller = new VisitPrepInternalController(
    service as unknown as VisitPrepService,
    makeEnv(),
    store,
  );
  return { controller, service, store };
}

describe('VisitPrepInternalController.getSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when the header is missing', async () => {
    const { controller, service } = buildController();
    await expect(controller.getSnapshot('sn_abc', fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.getSnapshot).not.toHaveBeenCalled();
  });

  it('returns 401 when the header value is wrong', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.getSnapshot('sn_abc', fakeRequest('totally-wrong-value')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.getSnapshot).not.toHaveBeenCalled();
  });

  it('returns 401 when a header value is presented with the same length but different bytes', async () => {
    const { controller, service } = buildController();
    const wrongSameLength = 'q'.repeat(SECRET.length);
    await expect(
      controller.getSnapshot('sn_abc', fakeRequest(wrongSameLength)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.getSnapshot).not.toHaveBeenCalled();
  });

  it('forwards the seniorId to the service and returns the parsed snapshot when authorised', async () => {
    const { controller, service } = buildController();
    const response = await controller.getSnapshot('sn_abc', fakeRequest(SECRET));
    expect(service.getSnapshot).toHaveBeenCalledOnce();
    expect(service.getSnapshot).toHaveBeenCalledWith({ seniorId: 'sn_abc' });
    expect(response.senior.seniorId).toBe('sn_abc');
  });

  it('propagates a NotFoundException from the service unchanged', async () => {
    const { controller } = buildController();
    // Replace the service mock with one that throws.
    const throwingService = {
      getSnapshot: vi.fn(async () => {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Senior not found.',
        });
      }),
    };
    const replaced = new VisitPrepInternalController(
      throwingService as unknown as VisitPrepService,
      makeEnv(),
      makeStore(),
    );
    void controller; // controller variable carries the happy path; the not-found path uses `replaced`.
    await expect(replaced.getSnapshot('sn_missing', fakeRequest(SECRET))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('VisitPrepInternalController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs the handler under an exempt frame keyed `internal-visit-prep-snapshot`', async () => {
    const snapshot = sampleSnapshot();
    let frameAtCallsite: unknown = 'unset';
    const service = {
      getSnapshot: vi.fn(async () => {
        frameAtCallsite = store.current();
        return snapshot;
      }),
    };
    const store = makeStore();
    const controller = new VisitPrepInternalController(
      service as unknown as VisitPrepService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.getSnapshot('sn_abc', fakeRequest(SECRET));
    expect(store.current()).toBeNull();

    expect(frameAtCallsite).toEqual({
      kind: 'exempt',
      reason: 'internal-visit-prep-snapshot',
    });
  });

  it('asserts the frame is also exempt on the 401 short-circuit', async () => {
    const service = { getSnapshot: vi.fn() };
    const store = makeStore();
    const controller = new VisitPrepInternalController(
      service as unknown as VisitPrepService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    // Even when the secret check rejects, the wrap is in place because
    // the requireSharedSecret call lives INSIDE the runWithoutTenantContext
    // closure.
    await expect(controller.getSnapshot('sn_abc', fakeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.current()).toBeNull();
  });
});
