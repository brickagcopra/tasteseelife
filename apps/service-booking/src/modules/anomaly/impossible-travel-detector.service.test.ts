import 'reflect-metadata';

import { BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL } from '@taste-and-see/contracts';
import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';

import {
  ImpossibleTravelDetectorService,
  impossibleTravelEventId,
} from './impossible-travel-detector.service';

/**
 * Unit tests for the detection sweep (TS-308a).
 *
 * The load-bearing assertions:
 *   - **no coordinates on the emitted event** — a check-in location is a
 *     senior's home address, and putting it on an event would put it in
 *     the Redis stream, every consumer's log, and the incident row;
 *   - the event id is DERIVED from the check-in pair, which is what
 *     makes re-detection a no-op against the outbox's
 *     `ON CONFLICT (event_id) DO NOTHING`;
 *   - the threshold in force is carried on the event, so retuning it
 *     later cannot rewrite why an old incident was opened;
 *   - providers are walked SEPARATELY — two providers' check-ins must
 *     never be paired with each other;
 *   - one failing append does not abort the sweep.
 */

const NOW = new Date('2026-07-26T12:00:00.000Z');

function row(
  id: string,
  providerId: string,
  latitude: number,
  longitude: number,
  occurredAt: string,
) {
  return {
    id,
    bookingId: `bk_${id}`,
    providerId,
    latitude,
    longitude,
    occurredAt: new Date(occurredAt),
  };
}

/** NYC then LA twenty minutes later — comfortably impossible. */
const IMPOSSIBLE_PAIR = [
  row('ci_1', 'prov_1', 40.7128, -74.006, '2026-07-26T10:00:00.000Z'),
  row('ci_2', 'prov_1', 34.0522, -118.2437, '2026-07-26T10:20:00.000Z'),
];

interface Appended {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: Record<string, unknown>;
}

interface Harness {
  readonly service: ImpossibleTravelDetectorService;
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
      return options.rows ?? IMPOSSIBLE_PAIR;
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

  return {
    service: new ImpossibleTravelDetectorService(prisma, outbox),
    appended,
    queries,
  };
}

function sweep(harness: Harness, maxSpeedKph = 1000) {
  return harness.service.sweep({ now: NOW, lookbackHours: 24, maxSpeedKph });
}

describe('ImpossibleTravelDetectorService.sweep', () => {
  it('emits one event for an impossible pair', async () => {
    const harness = makeHarness();

    const result = await sweep(harness);

    expect(result.scanned).toBe(2);
    expect(result.providers).toBe(1);
    expect(result.findings).toBe(1);
    expect(result.emitted).toBe(1);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.eventName).toBe(BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL);
  });

  it('NEVER puts coordinates on the event', async () => {
    // A check-in location is a senior's home address in decimal form.
    const harness = makeHarness();

    await sweep(harness);

    const serialised = JSON.stringify(harness.appended[0]?.payload);
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
    expect(serialised).not.toContain('40.7128');
    expect(serialised).not.toContain('-118.2437');
    expect(serialised).not.toContain('34.0522');
  });

  it('carries the derived scalars and the two check-in handles instead', async () => {
    const harness = makeHarness();

    await sweep(harness);

    const payload = harness.appended[0]?.payload ?? {};
    expect(payload['providerId']).toBe('prov_1');
    expect(payload['previousCheckInId']).toBe('ci_1');
    expect(payload['checkInId']).toBe('ci_2');
    expect(payload['previousBookingId']).toBe('bk_ci_1');
    expect(payload['bookingId']).toBe('bk_ci_2');
    expect(payload['elapsedSeconds']).toBe(1200);
    expect(Number(payload['distanceMeters'])).toBeGreaterThan(3_900_000);
    expect(Number(payload['impliedSpeedKph'])).toBeGreaterThan(1000);
  });

  it('carries the threshold IN FORCE, so retuning cannot rewrite history', async () => {
    const harness = makeHarness();

    await sweep(harness, 750);

    expect(harness.appended[0]?.payload['thresholdKph']).toBe(750);
  });

  it('derives the event id from the check-in pair — the dedup key', async () => {
    const harness = makeHarness();

    await sweep(harness);

    expect(harness.appended[0]?.eventId).toBe('impossible-travel:ci_1:ci_2');
    expect(harness.appended[0]?.payload['eventId']).toBe('impossible-travel:ci_1:ci_2');
  });

  it('walks providers SEPARATELY — two providers are never paired with each other', async () => {
    // Each provider alone is unremarkable; naively pairing across them
    // would report a 3,900 km jump that nobody made.
    const harness = makeHarness({
      rows: [
        row('ci_1', 'prov_1', 40.7128, -74.006, '2026-07-26T10:00:00.000Z'),
        row('ci_2', 'prov_2', 34.0522, -118.2437, '2026-07-26T10:20:00.000Z'),
      ],
    });

    const result = await sweep(harness);

    expect(result.providers).toBe(2);
    expect(result.findings).toBe(0);
    expect(harness.appended).toHaveLength(0);
  });

  it('emits nothing when every provider stayed put', async () => {
    const harness = makeHarness({
      rows: [
        row('ci_1', 'prov_1', 40.7128, -74.006, '2026-07-26T09:00:00.000Z'),
        row('ci_2', 'prov_1', 40.75, -73.99, '2026-07-26T11:00:00.000Z'),
      ],
    });

    const result = await sweep(harness);

    expect(result.findings).toBe(0);
    expect(harness.appended).toHaveLength(0);
  });

  it('handles an empty window without touching the outbox', async () => {
    const harness = makeHarness({ rows: [] });

    const result = await sweep(harness);

    expect(result).toEqual({ scanned: 0, providers: 0, findings: 0, emitted: 0 });
    expect(harness.appended).toHaveLength(0);
  });

  it('counts a finding but not an emission when the payload fails validation', async () => {
    const harness = makeHarness({ appendResult: 'validation_failed' });

    const result = await sweep(harness);

    expect(result.findings).toBe(1);
    expect(result.emitted).toBe(0);
  });

  it('does not abort the sweep when an append throws', async () => {
    const harness = makeHarness({ throwOnAppend: true });

    const result = await sweep(harness);

    expect(result.findings).toBe(1);
    expect(result.emitted).toBe(0);
  });

  it('keeps sweeping other providers after one provider fails', async () => {
    // Two impossible pairs across two providers; the append throws for
    // both, and the sweep still reports both findings rather than
    // stopping at the first.
    const harness = makeHarness({
      throwOnAppend: true,
      rows: [
        ...IMPOSSIBLE_PAIR,
        row('ci_3', 'prov_2', 40.7128, -74.006, '2026-07-26T10:00:00.000Z'),
        row('ci_4', 'prov_2', 34.0522, -118.2437, '2026-07-26T10:20:00.000Z'),
      ],
    });

    const result = await sweep(harness);

    expect(result.providers).toBe(2);
    expect(result.findings).toBe(2);
    expect(result.emitted).toBe(0);
  });

  it('issues exactly one scan query per sweep', async () => {
    const harness = makeHarness();

    await sweep(harness);

    expect(harness.queries).toHaveLength(1);
  });
});

describe('impossibleTravelEventId', () => {
  it('is stable and greppable', () => {
    const id = impossibleTravelEventId({
      previous: {
        id: 'ci_a',
        bookingId: 'bk_a',
        latitude: 0,
        longitude: 0,
        occurredAt: NOW,
      },
      current: {
        id: 'ci_b',
        bookingId: 'bk_b',
        latitude: 0,
        longitude: 0,
        occurredAt: NOW,
      },
      distanceMeters: 1,
      elapsedSeconds: 1,
      impliedSpeedKph: 1,
    });

    expect(id).toBe('impossible-travel:ci_a:ci_b');
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
