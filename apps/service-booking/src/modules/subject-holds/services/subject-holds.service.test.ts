import type { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { FakeHoldsPrisma, type FakeBookingRow } from './__fixtures__/fake-prisma';
import { SubjectHoldsService } from './subject-holds.service';

const OPENED_AT = new Date('2026-07-26T10:00:00.000Z');
const RESOLVED_AT = new Date('2026-07-27T09:00:00.000Z');

function buildService(): { service: SubjectHoldsService; fake: FakeHoldsPrisma } {
  const fake = new FakeHoldsPrisma();
  const service = new SubjectHoldsService(fake as unknown as PrismaService);
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  return { service, fake };
}

function booking(overrides: Partial<FakeBookingRow> = {}): FakeBookingRow {
  return {
    id: 'bkg_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: 'prv_1',
    status: 'pending',
    heldByIncidentId: null,
    heldAt: null,
    ...overrides,
  };
}

const HOLD_INPUT = {
  incidentId: 'inc_1',
  severity: 'critical',
  category: 'safety',
  providerId: 'prv_1' as string | null,
  seniorId: null as string | null,
  householdId: null as string | null,
  heldAt: OPENED_AT,
  sourceEventId: 'evt_1',
};

describe('SubjectHoldsService.applySubjectHold', () => {
  let service: SubjectHoldsService;
  let fake: FakeHoldsPrisma;

  beforeEach(() => {
    ({ service, fake } = buildService());
  });

  it('records one hold row per named subject', async () => {
    const result = await service.applySubjectHold({
      ...HOLD_INPUT,
      seniorId: 'sen_1',
      householdId: 'hh_1',
    });

    expect(result.holdsCreated).toBe(3);
    expect(fake.holds.map((h) => h.subjectKind).sort()).toEqual([
      'household',
      'provider',
      'senior',
    ]);
    // Every row carries the incident's clock, not the processing time.
    expect(fake.holds.every((h) => h.heldAt === OPENED_AT)).toBe(true);
  });

  it("suspends the subject's pending and confirmed bookings", async () => {
    fake.bookings = [
      booking({ id: 'bkg_pending', status: 'pending' }),
      booking({ id: 'bkg_confirmed', status: 'confirmed' }),
      booking({ id: 'bkg_in_progress', status: 'in_progress' }),
    ];

    const result = await service.applySubjectHold(HOLD_INPUT);

    expect(result.bookingsHeld).toBe(3);
    expect(fake.bookings.every((b) => b.heldByIncidentId === 'inc_1')).toBe(true);
    expect(fake.bookings.every((b) => b.heldAt === OPENED_AT)).toBe(true);
  });

  it('does NOT suspend terminal bookings — history is not re-frozen', async () => {
    fake.bookings = [
      booking({ id: 'bkg_completed', status: 'completed' }),
      booking({ id: 'bkg_canceled', status: 'canceled' }),
      booking({ id: 'bkg_declined', status: 'declined' }),
    ];

    const result = await service.applySubjectHold(HOLD_INPUT);

    expect(result.bookingsHeld).toBe(0);
    expect(fake.bookings.every((b) => b.heldByIncidentId === null)).toBe(true);
  });

  it('only suspends bookings involving a HELD subject', async () => {
    fake.bookings = [
      booking({ id: 'bkg_held', providerId: 'prv_1' }),
      booking({ id: 'bkg_other', providerId: 'prv_other', seniorId: 'sen_x', householdId: 'hh_x' }),
    ];

    await service.applySubjectHold(HOLD_INPUT);

    expect(fake.bookings.find((b) => b.id === 'bkg_held')?.heldByIncidentId).toBe('inc_1');
    expect(fake.bookings.find((b) => b.id === 'bkg_other')?.heldByIncidentId).toBeNull();
  });

  it("suspends a provider's bookings ACROSS households — the hold is cross-tenant by design", async () => {
    fake.bookings = [
      booking({ id: 'bkg_hh1', householdId: 'hh_1', seniorId: 'sen_1' }),
      booking({ id: 'bkg_hh2', householdId: 'hh_2', seniorId: 'sen_2' }),
    ];

    const result = await service.applySubjectHold(HOLD_INPUT);

    expect(result.bookingsHeld).toBe(2);
  });

  it('is idempotent on a redelivery of the same event', async () => {
    await service.applySubjectHold(HOLD_INPUT);
    const replay = await service.applySubjectHold(HOLD_INPUT);

    expect(replay.holdsCreated).toBe(0);
    expect(fake.holds).toHaveLength(1);
  });

  it('is idempotent on a re-publish under a NEW event id', async () => {
    await service.applySubjectHold(HOLD_INPUT);
    const republish = await service.applySubjectHold({
      ...HOLD_INPUT,
      sourceEventId: 'evt_republished',
    });

    expect(republish.holdsCreated).toBe(0);
    expect(fake.holds).toHaveLength(1);
  });

  it('leaves an EARLIER incident as the recorded reason — first hold wins', async () => {
    fake.bookings = [booking()];
    await service.applySubjectHold(HOLD_INPUT);

    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_2',
      sourceEventId: 'evt_2',
      heldAt: new Date('2026-07-26T14:00:00.000Z'),
    });

    expect(fake.bookings[0]?.heldByIncidentId).toBe('inc_1');
    expect(fake.bookings[0]?.heldAt).toBe(OPENED_AT);
    // But both holds are recorded, so the release re-evaluation can find the
    // second one.
    expect(fake.holds).toHaveLength(2);
  });

  it('refuses a subjectless hold rather than freezing the platform', async () => {
    fake.bookings = [booking()];

    const result = await service.applySubjectHold({
      ...HOLD_INPUT,
      providerId: null,
      seniorId: null,
      householdId: null,
    });

    expect(result).toEqual({ holdsCreated: 0, bookingsHeld: 0 });
    expect(fake.holds).toHaveLength(0);
    expect(fake.bookings[0]?.heldByIncidentId).toBeNull();
  });
});

describe('SubjectHoldsService.releaseSubjectHold', () => {
  let service: SubjectHoldsService;
  let fake: FakeHoldsPrisma;

  beforeEach(() => {
    ({ service, fake } = buildService());
  });

  it('clears the suspension when nothing else holds the booking', async () => {
    fake.bookings = [booking()];
    await service.applySubjectHold(HOLD_INPUT);

    const result = await service.releaseSubjectHold({
      incidentId: 'inc_1',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });

    expect(result).toEqual({ holdsReleased: 1, bookingsCleared: 1, bookingsRestamped: 0 });
    expect(fake.bookings[0]?.heldByIncidentId).toBeNull();
    expect(fake.bookings[0]?.heldAt).toBeNull();
    expect(fake.holds[0]?.releasedAt).toBe(RESOLVED_AT);
    expect(fake.holds[0]?.releaseEventId).toBe('evt_rel_1');
  });

  it('KEEPS the booking suspended when another open incident still covers it', async () => {
    // The case a naive "clear everything this incident held" release gets
    // wrong: a provider under two concurrent concerns, the first dismissed.
    fake.bookings = [booking()];
    await service.applySubjectHold(HOLD_INPUT);
    const secondHeldAt = new Date('2026-07-26T14:00:00.000Z');
    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_2',
      sourceEventId: 'evt_2',
      providerId: null,
      householdId: 'hh_1',
      heldAt: secondHeldAt,
    });

    const result = await service.releaseSubjectHold({
      incidentId: 'inc_1',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });

    expect(result.bookingsCleared).toBe(0);
    expect(result.bookingsRestamped).toBe(1);
    // Re-stamped with the SURVIVING incident, so the booking still explains
    // itself.
    expect(fake.bookings[0]?.heldByIncidentId).toBe('inc_2');
    expect(fake.bookings[0]?.heldAt).toEqual(secondHeldAt);
  });

  it('clears the booking once the LAST hold is released', async () => {
    fake.bookings = [booking()];
    await service.applySubjectHold(HOLD_INPUT);
    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_2',
      sourceEventId: 'evt_2',
      providerId: null,
      householdId: 'hh_1',
      heldAt: new Date('2026-07-26T14:00:00.000Z'),
    });

    await service.releaseSubjectHold({
      incidentId: 'inc_1',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });
    const second = await service.releaseSubjectHold({
      incidentId: 'inc_2',
      providerId: null,
      seniorId: null,
      householdId: 'hh_1',
      releasedAt: new Date('2026-07-28T09:00:00.000Z'),
      releaseEventId: 'evt_rel_2',
    });

    expect(second.bookingsCleared).toBe(1);
    expect(fake.bookings[0]?.heldByIncidentId).toBeNull();
  });

  it('is a no-op — not an error — for a hold that was never applied', async () => {
    const result = await service.releaseSubjectHold({
      incidentId: 'inc_never_applied',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });

    expect(result).toEqual({ holdsReleased: 0, bookingsCleared: 0, bookingsRestamped: 0 });
  });

  it('is idempotent on a redelivered release', async () => {
    fake.bookings = [booking()];
    await service.applySubjectHold(HOLD_INPUT);
    const release = {
      incidentId: 'inc_1',
      providerId: 'prv_1' as string | null,
      seniorId: null as string | null,
      householdId: null as string | null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    };

    await service.releaseSubjectHold(release);
    const replay = await service.releaseSubjectHold(release);

    expect(replay).toEqual({ holdsReleased: 0, bookingsCleared: 0, bookingsRestamped: 0 });
    // The first release's attribution survives the replay.
    expect(fake.holds[0]?.releaseEventId).toBe('evt_rel_1');
  });

  it('does not touch bookings held by a DIFFERENT incident', async () => {
    fake.bookings = [
      booking({ id: 'bkg_a', providerId: 'prv_1' }),
      booking({ id: 'bkg_b', providerId: 'prv_2', seniorId: 'sen_2', householdId: 'hh_2' }),
    ];
    await service.applySubjectHold(HOLD_INPUT);
    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_2',
      sourceEventId: 'evt_2',
      providerId: 'prv_2',
    });

    await service.releaseSubjectHold({
      incidentId: 'inc_1',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });

    expect(fake.bookings.find((b) => b.id === 'bkg_a')?.heldByIncidentId).toBeNull();
    expect(fake.bookings.find((b) => b.id === 'bkg_b')?.heldByIncidentId).toBe('inc_2');
  });
});

describe('SubjectHoldsService.screenSubjects', () => {
  let service: SubjectHoldsService;
  let fake: FakeHoldsPrisma;

  beforeEach(() => {
    ({ service, fake } = buildService());
  });

  it('reports nothing when the subjects are clear', async () => {
    await expect(
      service.screenSubjects({ providerId: 'prv_1', seniorId: 'sen_1', householdId: 'hh_1' }),
    ).resolves.toEqual([]);
  });

  it('reports an active hold on any of the three subjects', async () => {
    await service.applySubjectHold({ ...HOLD_INPUT, providerId: null, seniorId: 'sen_1' });

    const holds = await service.screenSubjects({
      providerId: 'prv_other',
      seniorId: 'sen_1',
      householdId: 'hh_other',
    });

    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      incidentId: 'inc_1',
      subjectKind: 'senior',
      subjectId: 'sen_1',
      severity: 'critical',
      category: 'safety',
    });
  });

  it('does NOT report a released hold', async () => {
    await service.applySubjectHold(HOLD_INPUT);
    await service.releaseSubjectHold({
      incidentId: 'inc_1',
      providerId: 'prv_1',
      seniorId: null,
      householdId: null,
      releasedAt: RESOLVED_AT,
      releaseEventId: 'evt_rel_1',
    });

    await expect(
      service.screenSubjects({ providerId: 'prv_1', seniorId: 'sen_1', householdId: 'hh_1' }),
    ).resolves.toEqual([]);
  });

  it('orders the oldest hold first, so the caller reports the longest-standing concern', async () => {
    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_newer',
      sourceEventId: 'evt_newer',
      heldAt: new Date('2026-07-26T20:00:00.000Z'),
    });
    await service.applySubjectHold({
      ...HOLD_INPUT,
      incidentId: 'inc_older',
      sourceEventId: 'evt_older',
      providerId: null,
      householdId: 'hh_1',
      heldAt: new Date('2026-07-20T08:00:00.000Z'),
    });

    const holds = await service.screenSubjects({
      providerId: 'prv_1',
      seniorId: 'sen_1',
      householdId: 'hh_1',
    });

    expect(holds.map((h) => h.incidentId)).toEqual(['inc_older', 'inc_newer']);
  });

  it('reports nothing — never everything — for an empty subject triple', async () => {
    await service.applySubjectHold(HOLD_INPUT);
    expect(fake.holds).toHaveLength(1);

    await expect(
      service.screenSubjects({ providerId: null, seniorId: null, householdId: null }),
    ).resolves.toEqual([]);
  });
});
