import 'reflect-metadata';

import { BOOKING_ANOMALY_MASS_CANCELLATION } from '@taste-and-see/contracts';
import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';

import { MassCancellationDetectorService } from './mass-cancellation-detector.service';

/**
 * Unit tests for the mass-cancellation sweep (TS-308c).
 *
 * The load-bearing assertions:
 *   - the event id is derived from `{subject}:{UTC day}`, which is what
 *     turns a rolling window re-observed every fifteen minutes into ONE
 *     incident rather than ninety-six;
 *   - **no cancellation reasons and no free text on the event** — the
 *     row carries `booking_notes` and `cancellation_reason_text`, both
 *     written by families about a named senior, and neither may cross
 *     the wire;
 *   - the threshold in force is carried, so retuning it later cannot
 *     rewrite why an old incident was opened;
 *   - one failing append does not abort the sweep.
 */

const NOW = new Date('2026-07-26T18:00:00.000Z');

function row(bookingId: string, overrides: Record<string, unknown> = {}) {
  return {
    bookingId,
    providerId: 'prv_1',
    householdId: 'hh_1',
    seriesId: null,
    canceledByUserId: 'usr_1',
    ...overrides,
  };
}

/** Four separate cancellations against one provider and one household. */
const BREACH_ROWS = [row('b1'), row('b2'), row('b3'), row('b4')];

interface Appended {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: Record<string, unknown>;
}

interface Harness {
  readonly service: MassCancellationDetectorService;
  readonly appended: Appended[];
  readonly queries: unknown[];
}

function makeHarness(
  options: {
    readonly rows?: readonly unknown[];
    readonly appendResult?: 'appended' | 'validation_failed';
    readonly throwOnAppend?: boolean;
  } = {},
): Harness {
  const appended: Appended[] = [];
  const queries: unknown[] = [];

  const prisma = {
    $queryRaw: async (...args: unknown[]) => {
      queries.push(args);
      return options.rows ?? BREACH_ROWS;
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as unknown as PrismaService;

  const outbox = {
    append: async (_tx: unknown, args: Appended) => {
      if (options.throwOnAppend === true) throw new Error('db down');
      appended.push(args);
      return options.appendResult === 'validation_failed'
        ? { kind: 'validation_failed', eventName: args.eventName, issues: [] }
        : { kind: 'appended', eventId: args.eventId, occurredAt: NOW };
    },
  } as unknown as OutboxService;

  return { service: new MassCancellationDetectorService(prisma, outbox), appended, queries };
}

function sweep(harness: Harness, provider = 3, household = 3) {
  return harness.service.sweep({
    now: NOW,
    windowHours: 24,
    thresholds: { provider, household },
  });
}

describe('MassCancellationDetectorService.sweep', () => {
  it('emits one event per breaching subject', async () => {
    const harness = makeHarness();

    const result = await sweep(harness);

    expect(result.scanned).toBe(4);
    expect(result.findings).toBe(2);
    expect(result.emitted).toBe(2);
    expect(harness.appended.map((a) => a.eventName)).toEqual([
      BOOKING_ANOMALY_MASS_CANCELLATION,
      BOOKING_ANOMALY_MASS_CANCELLATION,
    ]);
  });

  it('derives the event id from the subject and the UTC day', async () => {
    const harness = makeHarness();

    await sweep(harness);

    expect(harness.appended.map((a) => a.eventId)).toEqual([
      'mass-cancellation:provider:prv_1:2026-07-26',
      'mass-cancellation:household:hh_1:2026-07-26',
    ]);
    // The id is on the payload too, so a consumer sees the same handle
    // the outbox deduped on.
    expect(harness.appended[0]?.payload.eventId).toBe(
      'mass-cancellation:provider:prv_1:2026-07-26',
    );
  });

  it('produces the SAME ids on a later tick of the same day', async () => {
    // This is the whole dedup mechanism: the outbox insert is
    // `ON CONFLICT (event_id) DO NOTHING`, so the second tick is a
    // no-op rather than a second incident and a second SLA clock.
    const first = makeHarness();
    const second = makeHarness();

    await first.service.sweep({
      now: new Date('2026-07-26T06:00:00.000Z'),
      windowHours: 24,
      thresholds: { provider: 3, household: 3 },
    });
    await second.service.sweep({
      now: new Date('2026-07-26T23:45:00.000Z'),
      windowHours: 24,
      thresholds: { provider: 3, household: 3 },
    });

    expect(second.appended.map((a) => a.eventId)).toEqual(first.appended.map((a) => a.eventId));
  });

  it('produces DIFFERENT ids the next day — behaviour that continues opens a fresh incident', async () => {
    const harness = makeHarness();

    await harness.service.sweep({
      now: new Date('2026-07-27T00:15:00.000Z'),
      windowHours: 24,
      thresholds: { provider: 3, household: 3 },
    });

    expect(harness.appended[0]?.eventId).toBe('mass-cancellation:provider:prv_1:2026-07-27');
  });

  it('NEVER puts a cancellation reason or free text on the event', async () => {
    const harness = makeHarness({
      rows: BREACH_ROWS.map((r) => ({
        ...r,
        // Fields the row carries that the projection deliberately drops.
        cancellationReason: 'welfare_concern',
        cancellationReasonText: 'she was very confused when I arrived',
        bookingNotes: 'door code 4821',
      })),
    });

    await sweep(harness);

    const serialised = JSON.stringify(harness.appended.map((a) => a.payload));
    expect(serialised).not.toContain('welfare_concern');
    expect(serialised).not.toContain('confused');
    expect(serialised).not.toContain('4821');
    expect(serialised).not.toContain('cancellationReason');
  });

  it('carries the counts, the window and the threshold in force', async () => {
    const harness = makeHarness();

    await sweep(harness, 3, 99);

    const payload = harness.appended[0]?.payload ?? {};
    expect(payload).toMatchObject({
      subjectKind: 'provider',
      subjectId: 'prv_1',
      windowStart: '2026-07-25T18:00:00.000Z',
      windowEnd: '2026-07-26T18:00:00.000Z',
      windowBucket: '2026-07-26',
      canceledBookingCount: 4,
      distinctCancellationCount: 4,
      threshold: 3,
      distinctActorCount: 1,
      unattributedCount: 0,
    });
    // The household threshold of 99 was not breached, so only the
    // provider event exists.
    expect(harness.appended).toHaveLength(1);
  });

  it('collapses a cancelled recurring series before comparing to the threshold', async () => {
    const harness = makeHarness({
      rows: Array.from({ length: 12 }, (_unused, i) => row(`b_${i}`, { seriesId: 'ser_1' })),
    });

    const result = await sweep(harness);

    expect(result.findings).toBe(0);
    expect(harness.appended).toHaveLength(0);
  });

  it('emits nothing when no subject breaches', async () => {
    const harness = makeHarness({ rows: [row('b1'), row('b2')] });

    const result = await sweep(harness);

    expect(result.findings).toBe(0);
    expect(result.emitted).toBe(0);
  });

  it('counts a validation failure as a finding but not an emission', async () => {
    const harness = makeHarness({ appendResult: 'validation_failed' });

    const result = await sweep(harness);

    expect(result.findings).toBe(2);
    expect(result.emitted).toBe(0);
  });

  it('continues the sweep when one append throws', async () => {
    // A detector that dies on one bad finding stops detecting
    // everything else.
    const harness = makeHarness({ throwOnAppend: true });

    const result = await sweep(harness);

    expect(result.findings).toBe(2);
    expect(result.emitted).toBe(0);
  });

  it('scans from `now` minus the window', async () => {
    const harness = makeHarness();

    await harness.service.sweep({
      now: NOW,
      windowHours: 6,
      thresholds: { provider: 3, household: 3 },
    });

    const params = harness.queries[0] as unknown[];
    const windowStart = params[params.length - 1];
    expect(windowStart).toBeInstanceOf(Date);
    expect((windowStart as Date).toISOString()).toBe('2026-07-26T12:00:00.000Z');
  });
});
