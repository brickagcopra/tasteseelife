import 'reflect-metadata';

import type { BookingAnomalySubjectKind } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { IncidentsService } from '../../incidents/services/incidents.service';

import { MassCancellationHandler, gradeMassCancellation } from './mass-cancellation.handler';

/**
 * Unit tests for the mass-cancellation consumer (TS-308c).
 *
 * The load-bearing assertions:
 *   - **neither subject may ever grade `high`.** `high` triggers
 *     TS-304's booking hold, so the platform's response to care being
 *     cancelled would be to cancel more care — the detector would
 *     amplify exactly the harm it exists to notice;
 *   - the two subjects get DIFFERENT grades and DIFFERENT categories,
 *     which is the whole reason a consumer sits between the counter and
 *     the incident;
 *   - exactly ONE subject is named on the incident;
 *   - the incident's `description` is null, because the event carries no
 *     reasons and no free text and there is nothing to put there;
 *   - `sourceEventId` is set, which is the domain idempotency guard;
 *   - a duplicate (P2002) is swallowed, anything else rethrows so the
 *     SDK redelivers.
 */

function payload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'mass-cancellation:provider:prv_1:2026-07-26',
    subjectKind: 'provider' as BookingAnomalySubjectKind,
    subjectId: 'prv_1',
    windowStart: '2026-07-25T18:00:00.000Z',
    windowEnd: '2026-07-26T18:00:00.000Z',
    windowBucket: '2026-07-26',
    canceledBookingCount: 9,
    distinctCancellationCount: 6,
    threshold: 5,
    distinctActorCount: 1,
    unattributedCount: 0,
    occurredAt: '2026-07-26T18:00:00.000Z',
    ...overrides,
  };
}

function args(overrides: Record<string, unknown> = {}) {
  const body = payload(overrides);
  return {
    envelope: { eventId: body.eventId },
    payload: body,
  } as unknown as Parameters<MassCancellationHandler['handle']>[0];
}

interface Harness {
  readonly handler: MassCancellationHandler;
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

  return { handler: new MassCancellationHandler(incidents), created };
}

describe('MassCancellationHandler.handle', () => {
  it('opens a system-sourced conduct incident against a provider', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(args());

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: 'system',
      category: 'conduct',
      severity: 'medium',
      providerId: 'prv_1',
      sourceEventId: 'mass-cancellation:provider:prv_1:2026-07-26',
    });
  });

  it('opens a system-sourced billing incident against a household', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(
      args({
        subjectKind: 'household',
        subjectId: 'hh_1',
        eventId: 'mass-cancellation:household:hh_1:2026-07-26',
      }),
    );

    expect(created[0]).toMatchObject({
      category: 'billing',
      severity: 'low',
      householdId: 'hh_1',
    });
  });

  it('records the counts and the window as system evidence (TS-308c-followup-2)', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(args());

    expect(created[0]?.['evidence']).toEqual({
      detector: 'mass_cancellation',
      subjectKind: 'provider',
      windowStart: '2026-07-25T18:00:00.000Z',
      windowEnd: '2026-07-26T18:00:00.000Z',
      canceledBookingCount: 9,
      distinctCancellationCount: 6,
      threshold: 5,
      distinctActorCount: 1,
      unattributedCount: 0,
    });
  });

  it('carries NO subject id and NO reasons into the evidence', async () => {
    // The subject is already a first-class column on the incident, and
    // the event carries no reasons at all — the evidence must not become
    // the place either sneaks back in.
    const { handler, created } = makeHarness();

    await handler.handle(args());

    expect(created[0]?.['evidence']).not.toHaveProperty('subjectId');
    const serialised = JSON.stringify(created[0]?.['evidence']);
    expect(serialised).not.toContain('reason');
  });

  it('names EXACTLY ONE subject', async () => {
    // Naming both would assert that a household whose bookings happen to
    // sit inside a breaching provider's window is itself under review.
    const { handler, created } = makeHarness();

    await handler.handle(args());
    expect(created[0]).not.toHaveProperty('householdId');
    expect(created[0]).not.toHaveProperty('seniorId');

    const second = makeHarness();
    await second.handler.handle(args({ subjectKind: 'household', subjectId: 'hh_1' }));
    expect(second.created[0]).not.toHaveProperty('providerId');
  });

  it('opens the incident with NO description and NO reporter', async () => {
    const { handler, created } = makeHarness();

    await handler.handle(args());

    expect(created[0]).not.toHaveProperty('description');
    expect(created[0]).not.toHaveProperty('reporterUserId');
  });

  it('swallows a duplicate (P2002) — the incident it would open already exists', async () => {
    const { handler } = makeHarness({ throws: { code: 'P2002' } });

    await expect(handler.handle(args())).resolves.toBeUndefined();
  });

  it('rethrows anything else so the SDK redelivers', async () => {
    const { handler } = makeHarness({ throws: new Error('connection reset') });

    await expect(handler.handle(args())).rejects.toThrow('connection reset');
  });
});

describe('gradeMassCancellation', () => {
  const kinds: readonly BookingAnomalySubjectKind[] = ['provider', 'household'];

  it('NEVER grades `high` — that would suspend the subject’s remaining bookings', async () => {
    // TS-304 holds a subject's visits on `high`. On a mass-cancellation
    // finding that means responding to cancelled care by cancelling more
    // care. This assertion is the guard on that.
    for (const kind of kinds) {
      expect(gradeMassCancellation(kind).severity).not.toBe('high');
    }
  });

  it('NEVER grades `critical` — there is nothing to do at 3am about visits already cancelled', () => {
    for (const kind of kinds) {
      expect(gradeMassCancellation(kind).severity).not.toBe('critical');
    }
  });

  it('grades a provider ABOVE a household', () => {
    // A provider's day of committed care disappearing is felt by several
    // families at once; a household breach is most likely a family in
    // crisis and must not be treated as the more urgent of the two.
    expect(gradeMassCancellation('provider')).toEqual({
      category: 'conduct',
      severity: 'medium',
    });
    expect(gradeMassCancellation('household')).toEqual({
      category: 'billing',
      severity: 'low',
    });
  });
});
