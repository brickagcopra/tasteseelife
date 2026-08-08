import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  WELLNESS_TREND_METRICS,
  WellnessTrendsQuerySchema,
  type InternalSeniorWellnessObservationSummaryResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { WellnessObservationSummaryService } from '../services/wellness-observation-summary.service';
import { WellnessObservationSummaryController } from './wellness-observation-summary.controller';

/**
 * `WellnessObservationSummaryController` tests (TS-235).
 *
 * The behavioural surface is small: verify the shared-secret header,
 * call the service, parse the response. Covered:
 *
 *   - 200 happy path → service called with the path-param householdId +
 *     seniorId + validated windowDays, response parsed at the boundary.
 *   - 401 on a missing / wrong-length / same-length-wrong header.
 *   - the handler runs inside the `internal-wellness-observation-summary`
 *     exempt frame (tenant-scope wrap contract), 401 branch included.
 *   - `WellnessTrendsQuerySchema` default + validation (the pipe wired on
 *     the `windowDays` query param).
 *
 * A FAKE `WellnessObservationSummaryService` returns a canned response so
 * no Prisma / WellnessTrendsService is needed.
 */

const SECRET = 'x'.repeat(40);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
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

function cannedResponse(): InternalSeniorWellnessObservationSummaryResponse {
  return {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 3,
    metrics: WELLNESS_TREND_METRICS.map((metric) => ({
      metric,
      latestScore: 4,
      averageScore: 3.5,
      visitsRecorded: 2,
    })),
    generatedAt: '2026-05-27T12:00:00.000Z',
  };
}

function buildController(): {
  controller: WellnessObservationSummaryController;
  buildSummary: ReturnType<typeof vi.fn>;
} {
  const buildSummary = vi.fn(async () => cannedResponse());
  const service = { buildSummary } as unknown as WellnessObservationSummaryService;
  const controller = new WellnessObservationSummaryController(service, makeEnv(), makeStore());
  return { controller, buildSummary };
}

describe('WellnessObservationSummaryController.getSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the summary and forwards the path params + window on a valid secret', async () => {
    const { controller, buildSummary } = buildController();
    const response = await controller.getSummary(
      'hh_99',
      'snr_7',
      { windowDays: 90 },
      fakeRequest(SECRET),
    );
    expect(buildSummary).toHaveBeenCalledTimes(1);
    expect(buildSummary).toHaveBeenCalledWith({
      householdId: 'hh_99',
      seniorId: 'snr_7',
      windowDays: 90,
    });
    expect(response.seniorId).toBe('snr_1');
    expect(response.metrics).toHaveLength(WELLNESS_TREND_METRICS.length);
    expect(response.generatedAt).toBe('2026-05-27T12:00:00.000Z');
  });

  it('returns 401 when the header is missing', async () => {
    const { controller, buildSummary } = buildController();
    await expect(
      controller.getSummary('hh_1', 'snr_1', { windowDays: 30 }, fakeRequest(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(buildSummary).not.toHaveBeenCalled();
  });

  it('returns 401 when the header value is wrong (different length)', async () => {
    const { controller } = buildController();
    await expect(
      controller.getSummary('hh_1', 'snr_1', { windowDays: 30 }, fakeRequest('short')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 when the header value is wrong (same length)', async () => {
    const { controller } = buildController();
    await expect(
      controller.getSummary('hh_1', 'snr_1', { windowDays: 30 }, fakeRequest('y'.repeat(40))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * Query-param validation contract — the `ZodValidationPipe` wired on the
 * `windowDays` query param is `WellnessTrendsQuerySchema`. Exercised
 * directly here (the controller method receives the already-validated
 * value, so the pipe is the unit under test for the query contract).
 */
describe('WellnessObservationSummaryController windowDays query validation', () => {
  const pipe = new ZodValidationPipe(WellnessTrendsQuerySchema);

  it('defaults windowDays to 30 when omitted', () => {
    const parsed = pipe.transform({}) as { windowDays: number };
    expect(parsed.windowDays).toBe(30);
  });

  it('coerces and accepts windowDays=90', () => {
    const parsed = pipe.transform({ windowDays: '90' }) as { windowDays: number };
    expect(parsed.windowDays).toBe(90);
  });

  it('rejects an out-of-set windowDays (e.g. 7)', () => {
    expect(() => pipe.transform({ windowDays: '7' })).toThrow(BadRequestException);
  });

  it('rejects an unknown query field (strict schema)', () => {
    expect(() => pipe.transform({ windowDays: '30', extra: 'x' })).toThrow(BadRequestException);
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * The endpoint is a Prisma-touching pre-auth surface — it pins a
 * shared-secret header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. Without an
 * explicit exempt wrap, the downstream Prisma read (via
 * `WellnessTrendsService`) would hard-fail with
 * `MissingRequestContextError` under the `enforce` posture. These tests
 * pin the wrap by capturing `store.current()` at the collaborator
 * callsite (200 path) and at the header probe (401 path).
 */
describe('WellnessObservationSummaryController tenant-scope exempt wrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs getSummary inside an exempt frame with reason "internal-wellness-observation-summary"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeService = {
      buildSummary: vi.fn(async () => {
        captured = store.current();
        return cannedResponse();
      }),
    } as unknown as WellnessObservationSummaryService;
    const controller = new WellnessObservationSummaryController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await controller.getSummary('hh_1', 'snr_1', { windowDays: 30 }, fakeRequest(SECRET));
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-wellness-observation-summary',
    });
  });

  it('runs the 401 branch inside the same exempt frame', async () => {
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
      buildSummary: vi.fn(),
    } as unknown as WellnessObservationSummaryService;
    const controller = new WellnessObservationSummaryController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    await expect(
      controller.getSummary('hh_1', 'snr_1', { windowDays: 30 }, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-wellness-observation-summary',
    });
  });
});
