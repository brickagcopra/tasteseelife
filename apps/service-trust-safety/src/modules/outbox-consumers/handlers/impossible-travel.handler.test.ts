import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { IncidentsService } from '../../incidents/services/incidents.service';

import { IMPOSSIBLE_TRAVEL_SEVERITY, ImpossibleTravelHandler } from './impossible-travel.handler';

/**
 * Unit tests for the impossible-travel consumer (TS-308a).
 *
 * The load-bearing assertions:
 *   - the grade is **`medium`, never `high`** — `high` triggers TS-304's
 *     booking hold, and cancelling a family's week of care on the
 *     strength of a GPS reading would do more harm than the anomaly it
 *     responds to;
 *   - the incident's `description` is null, because the event carries no
 *     location and there is nothing to put there;
 *   - `sourceEventId` is set, which is the domain idempotency guard;
 *   - a duplicate (P2002) is swallowed, anything else rethrows so the
 *     SDK redelivers.
 */

const PAYLOAD = {
  eventId: 'impossible-travel:ci_1:ci_2',
  providerId: 'prov_1',
  previousCheckInId: 'ci_1',
  checkInId: 'ci_2',
  previousBookingId: 'bk_1',
  bookingId: 'bk_2',
  distanceMeters: 3_936_000,
  elapsedSeconds: 1200,
  impliedSpeedKph: 11_808,
  thresholdKph: 1000,
  previousOccurredAt: '2026-07-26T10:00:00.000Z',
  occurredAt: '2026-07-26T10:20:00.000Z',
};

const ARGS = {
  envelope: { eventId: 'impossible-travel:ci_1:ci_2' },
  payload: PAYLOAD,
} as unknown as Parameters<ImpossibleTravelHandler['handle']>[0];

interface Harness {
  readonly handler: ImpossibleTravelHandler;
  readonly created: Array<Record<string, unknown>>;
}

function makeHarness(options: { readonly throws?: unknown } = {}): Harness {
  const created: Array<Record<string, unknown>> = [];
  const incidents = {
    createIncident: async (input: Record<string, unknown>) => {
      if (options.throws !== undefined) throw options.throws;
      created.push(input);
      return { id: 'inc_1' };
    },
  } as unknown as IncidentsService;

  return { handler: new ImpossibleTravelHandler(incidents), created };
}

describe('ImpossibleTravelHandler.handle', () => {
  it('records the derived scalars as system evidence, and still no coordinates (TS-308c-followup-2)', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(ARGS);

    const evidence = created[0]?.['evidence'];
    expect(evidence).toMatchObject({
      detector: 'impossible_travel',
      impliedSpeedKph: 11_808,
      thresholdKph: 1000,
      previousCheckInId: 'ci_1',
      checkInId: 'ci_2',
    });
    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
  });

  it('opens a system-sourced safety incident against the provider', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(ARGS);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: 'system',
      category: 'safety',
      providerId: 'prov_1',
    });
  });

  it('grades it MEDIUM — never high, which would suspend the provider bookings', async () => {
    // TS-304 holds a subject's bookings on `high`. A GPS anomaly is not
    // grounds to cancel a family's week of care; an operator escalates
    // in one step once they have looked.
    const { handler, created } = makeHarness();

    await handler.handle(ARGS);

    expect(created[0]?.['severity']).toBe('medium');
    expect(IMPOSSIBLE_TRAVEL_SEVERITY).toBe('medium');
  });

  it('never grades it critical — that pages on-call at 3am', () => {
    expect(IMPOSSIBLE_TRAVEL_SEVERITY).not.toBe('critical');
  });

  it('carries NO description — the event has no location and nothing else to say', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(ARGS);

    expect(created[0]?.['description']).toBeUndefined();
    expect(created[0]?.['reporterUserId']).toBeUndefined();
  });

  it('sets sourceEventId — the domain idempotency guard', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(ARGS);

    expect(created[0]?.['sourceEventId']).toBe('impossible-travel:ci_1:ci_2');
  });

  it('swallows a duplicate (P2002) — the incident it would open already exists', async () => {
    const { handler } = makeHarness({ throws: { code: 'P2002' } });

    await expect(handler.handle(ARGS)).resolves.toBeUndefined();
  });

  it('rethrows anything else so the SDK redelivers from the PEL', async () => {
    const { handler } = makeHarness({ throws: new Error('db down') });

    await expect(handler.handle(ARGS)).rejects.toThrow('db down');
  });
});
