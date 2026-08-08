import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  BookingHoldPage,
  SubjectHoldsReadService,
} from '../services/subject-holds-read.service';

import { AdminBookingHoldsController } from './admin-booking-holds.controller';

/**
 * Controller tests for the admin booking-hold read (TS-304-followup-3).
 *
 * The load-bearing assertions:
 *   - gated `trust_safety:read` — the roster of who is under
 *     investigation does not belong behind a booking permission;
 *   - a missing count maps to ZERO, because "this hold is interrupting
 *     nothing right now" is an answer, not missing data;
 *   - `subjectId` without `subjectKind` is a 400;
 *   - no narrative field can reach the wire.
 */

const ROW = {
  id: 'bsh_1',
  incidentId: 'inc_1',
  subjectKind: 'provider' as const,
  subjectId: 'prov_1',
  severity: 'high',
  category: 'safety',
  heldAt: new Date('2026-07-20T10:00:00.000Z'),
  releasedAt: null,
};

interface Harness {
  readonly controller: AdminBookingHoldsController;
  readonly capture: { listArg?: unknown };
}

function makeHarness(page?: Partial<BookingHoldPage>): Harness {
  const capture: Harness['capture'] = {};
  const holds = {
    listHolds: async (arg: unknown) => {
      capture.listArg = arg;
      return {
        rows: page?.rows ?? [ROW],
        total: page?.total ?? 1,
        suspendedBookingCounts: page?.suspendedBookingCounts ?? new Map([['inc_1', 4]]),
      };
    },
  } as unknown as SubjectHoldsReadService;

  return { controller: new AdminBookingHoldsController(holds), capture };
}

describe('AdminBookingHoldsController.listHolds', () => {
  it('returns a contract-shaped page', async () => {
    const { controller } = makeHarness({ total: 12 });

    const response = await controller.listHolds({});

    expect(response.total).toBe(12);
    expect(response.holds[0]).toEqual({
      id: 'bsh_1',
      incidentId: 'inc_1',
      subjectKind: 'provider',
      subjectId: 'prov_1',
      severity: 'high',
      category: 'safety',
      heldAt: '2026-07-20T10:00:00.000Z',
      releasedAt: null,
      incidentSuspendedBookingCount: 4,
    });
  });

  it('maps a missing count to ZERO rather than omitting the field', async () => {
    const { controller } = makeHarness({ suspendedBookingCounts: new Map() });

    const response = await controller.listHolds({});

    expect(response.holds[0]?.incidentSuspendedBookingCount).toBe(0);
  });

  it('defaults to active holds', async () => {
    const { controller, capture } = makeHarness();

    await controller.listHolds({});

    expect(capture.listArg).toEqual({ status: 'active', limit: 50, offset: 0 });
  });

  it('echoes the applied limit and offset', async () => {
    const { controller } = makeHarness();

    const response = await controller.listHolds({ limit: '10', offset: '30' });

    expect(response.limit).toBe(10);
    expect(response.offset).toBe(30);
  });

  it('renders a released hold with its releasedAt', async () => {
    const { controller } = makeHarness({
      rows: [{ ...ROW, releasedAt: new Date('2026-07-24T09:00:00.000Z') }],
      suspendedBookingCounts: new Map(),
    });

    const response = await controller.listHolds({ status: 'released' });

    expect(response.holds[0]?.releasedAt).toBe('2026-07-24T09:00:00.000Z');
    expect(response.holds[0]?.incidentSuspendedBookingCount).toBe(0);
  });

  it('400s on subjectId without subjectKind', async () => {
    const { controller } = makeHarness();

    await expect(controller.listHolds({ subjectId: 'prov_1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s on an unknown status value', async () => {
    const { controller } = makeHarness();

    await expect(controller.listHolds({ status: 'lifted' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s on an unknown filter key rather than returning an unfiltered list', async () => {
    const { controller } = makeHarness();

    await expect(controller.listHolds({ severity: 'high' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('carries no narrative field on any row', async () => {
    // The concern's description is a family's account of a named senior.
    // It lives behind `trust_safety:write` on the incident detail; this
    // surface must never grow a copy.
    const { controller } = makeHarness();

    const response = await controller.listHolds({});

    const keys = Object.keys(response.holds[0] ?? {});
    expect(keys).not.toContain('description');
    expect(keys).not.toContain('resolutionNotes');
    expect(keys).not.toContain('notes');
  });

  it('returns an empty page without error', async () => {
    const { controller } = makeHarness({
      rows: [],
      total: 0,
      suspendedBookingCounts: new Map(),
    });

    const response = await controller.listHolds({});

    expect(response.holds).toEqual([]);
    expect(response.total).toBe(0);
  });

  it('is gated on trust_safety:read, not a booking permission', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminBookingHoldsController.prototype.listHolds,
    ) as unknown;

    expect(permissions).toEqual(['trust_safety:read']);
  });
});
