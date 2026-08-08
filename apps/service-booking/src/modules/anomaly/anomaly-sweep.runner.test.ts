import 'reflect-metadata';

import type {
  BullMqSchedulerService,
  ScheduledSweepSpec,
} from '@taste-and-see/nest-bullmq-scheduler';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';

import { ANOMALY_SWEEP_QUEUE_NAME, AnomalySweepRunner } from './anomaly-sweep.runner';
import type { ImpossibleTravelDetectorService } from './impossible-travel-detector.service';
import type { MassCancellationDetectorService } from './mass-cancellation-detector.service';

/**
 * Unit tests for the sweep runner (TS-308a, TS-308c).
 *
 * Constructed DIRECTLY rather than through `Test.createTestingModule` —
 * vitest/esbuild emits no `design:paramtypes`, so a constructor relying
 * on bare param types resolves to `undefined` under this runner. Same
 * reason service-accounting's and service-trust-safety's consumer suites
 * construct directly.
 *
 * Since TS-308a-followup-1 the queue lifecycle lives in
 * `@taste-and-see/nest-bullmq-scheduler`, so the scheduler is faked here
 * and the prefix / shutdown / connection assertions moved to that
 * package's own suite. What remains is what booking decides:
 *
 *   - the kill switch is handed through with the env var that controls
 *     it, and the SCHEDULER is what turns that into "no queue at all" —
 *     which is what makes it usable when a mis-tuned threshold is
 *     filling the trust & safety queue and ops needs it off without a
 *     redeploy;
 *   - the sweep is driven with the CONFIGURED window and ceiling, not
 *     the detector's own defaults;
 *   - **every detector runs even when an earlier one throws** (TS-308c).
 *     Letting a database blip in the check-in scan silently cost the
 *     platform its cancellation detection — with nothing in the logs to
 *     say a detector was skipped rather than clean — is exactly the
 *     quiet failure this track exists to avoid.
 */

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    BOOKING_ANOMALY_DETECTION_ENABLED: true,
    BOOKING_ANOMALY_SWEEP_INTERVAL_MS: 900_000,
    BOOKING_ANOMALY_LOOKBACK_HOURS: 24,
    BOOKING_ANOMALY_MAX_SPEED_KPH: 1_000,
    BOOKING_MASS_CANCELLATION_ENABLED: true,
    BOOKING_MASS_CANCELLATION_WINDOW_HOURS: 24,
    BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD: 5,
    BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD: 6,
    ...overrides,
  } as unknown as Env;
}

interface Harness {
  readonly runner: AnomalySweepRunner;
  readonly capture: {
    specs: ScheduledSweepSpec[];
    sweeps: Array<{ lookbackHours: number; maxSpeedKph: number }>;
    cancellationSweeps: Array<{
      windowHours: number;
      thresholds: { provider: number; household: number };
    }>;
  };
}

function makeHarness(
  options: {
    readonly env?: Partial<Env>;
    readonly travelSweepThrows?: boolean;
    readonly cancellationSweepThrows?: boolean;
  } = {},
): Harness {
  const capture: Harness['capture'] = {
    specs: [],
    sweeps: [],
    cancellationSweeps: [],
  };

  const scheduler = {
    schedule: async (spec: ScheduledSweepSpec) => {
      capture.specs.push(spec);
    },
  } as unknown as BullMqSchedulerService;

  const detector = {
    sweep: async (args: { lookbackHours: number; maxSpeedKph: number }) => {
      capture.sweeps.push({ lookbackHours: args.lookbackHours, maxSpeedKph: args.maxSpeedKph });
      if (options.travelSweepThrows === true) throw new Error('check-in scan failed');
      return { scanned: 0, providers: 0, findings: 0, emitted: 0 };
    },
  } as unknown as ImpossibleTravelDetectorService;

  const massCancellation = {
    sweep: async (args: {
      windowHours: number;
      thresholds: { provider: number; household: number };
    }) => {
      capture.cancellationSweeps.push({
        windowHours: args.windowHours,
        thresholds: args.thresholds,
      });
      if (options.cancellationSweepThrows === true) throw new Error('cancellation scan failed');
      return { scanned: 0, subjects: 0, findings: 0, emitted: 0 };
    },
  } as unknown as MassCancellationDetectorService;

  const runner = new AnomalySweepRunner(
    buildEnv(options.env ?? {}),
    scheduler,
    detector,
    massCancellation,
  );

  return { runner, capture };
}

describe('AnomalySweepRunner', () => {
  it('registers the sweep at the configured interval', async () => {
    const { runner, capture } = makeHarness();

    await runner.onModuleInit();

    expect(capture.specs).toHaveLength(1);
    expect(capture.specs[0]?.intervalMs).toBe(900_000);
  });

  it('hands the kill switch through with the env var that controls it', async () => {
    const { runner, capture } = makeHarness({
      env: { BOOKING_ANOMALY_DETECTION_ENABLED: false },
    });

    await runner.onModuleInit();

    expect(capture.specs[0]?.enabled).toBe(false);
    expect(capture.specs[0]?.disabledBy).toBe('BOOKING_ANOMALY_DETECTION_ENABLED');
  });

  it('echoes every configured window and threshold onto the arm-time log line', async () => {
    // An operator reading "why did this not fire" needs the numbers in
    // force, not the defaults in the source.
    const { runner, capture } = makeHarness();

    await runner.onModuleInit();

    expect(capture.specs[0]?.details).toMatchObject({
      lookbackHours: 24,
      maxSpeedKph: 1_000,
      massCancellationEnabled: true,
      massCancellationProviderThreshold: 5,
      massCancellationHouseholdThreshold: 6,
    });
  });

  it('drives the sweep with the CONFIGURED window and ceiling', async () => {
    const { runner, capture } = makeHarness({
      env: { BOOKING_ANOMALY_LOOKBACK_HOURS: 6, BOOKING_ANOMALY_MAX_SPEED_KPH: 750 },
    });

    await runner.runSweep(new Date('2026-07-26T12:00:00.000Z'));

    expect(capture.sweeps).toEqual([{ lookbackHours: 6, maxSpeedKph: 750 }]);
  });

  it('runs the sweep when the scheduler fires its processor', async () => {
    const { runner, capture } = makeHarness();

    await runner.onModuleInit();
    await capture.specs[0]?.processor();

    expect(capture.sweeps).toHaveLength(1);
  });

  it('exposes a stable queue name', () => {
    expect(ANOMALY_SWEEP_QUEUE_NAME).toBe('booking-anomaly-sweep');
  });
});

describe('AnomalySweepRunner.runSweep — multiple detectors on one tick (TS-308c)', () => {
  it('drives the cancellation detector with the configured window and thresholds', async () => {
    const { runner, capture } = makeHarness({
      env: {
        BOOKING_MASS_CANCELLATION_WINDOW_HOURS: 12,
        BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD: 4,
        BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD: 9,
      } as Partial<Env>,
    });

    await runner.runSweep();

    expect(capture.cancellationSweeps).toEqual([
      { windowHours: 12, thresholds: { provider: 4, household: 9 } },
    ]);
  });

  it('skips ONLY the cancellation detector when its own kill switch is off', async () => {
    // Separate switches because the two detectors have independent
    // thresholds and independent false-positive modes: a mis-tuned
    // cancellation threshold must not cost ops the location detector.
    const { runner, capture } = makeHarness({
      env: { BOOKING_MASS_CANCELLATION_ENABLED: false } as Partial<Env>,
    });

    await runner.runSweep();

    expect(capture.cancellationSweeps).toHaveLength(0);
    expect(capture.sweeps).toHaveLength(1);
  });

  it('still runs the cancellation detector when the travel sweep throws', async () => {
    const { runner, capture } = makeHarness({ travelSweepThrows: true });

    await expect(runner.runSweep()).rejects.toThrow('check-in scan failed');

    // The throw is re-raised so BullMQ marks the job failed — but only
    // AFTER every detector has had its turn.
    expect(capture.cancellationSweeps).toHaveLength(1);
  });

  it('re-raises the travel failure when the cancellation sweep throws too', async () => {
    const { runner, capture } = makeHarness({
      travelSweepThrows: true,
      cancellationSweepThrows: true,
    });

    await expect(runner.runSweep()).rejects.toThrow(
      /check-in scan failed.*cancellation scan failed/,
    );

    expect(capture.sweeps).toHaveLength(1);
    expect(capture.cancellationSweeps).toHaveLength(1);
  });

  it('re-raises a cancellation-only failure unwrapped', async () => {
    const { runner } = makeHarness({ cancellationSweepThrows: true });

    await expect(runner.runSweep()).rejects.toThrow('cancellation scan failed');
  });

  it('passes ONE clock to every detector', async () => {
    // Two detectors reading two slightly different `now`s would put
    // overlapping-but-unequal windows on findings from the same tick.
    const { runner, capture } = makeHarness();

    await runner.runSweep(new Date('2026-07-26T18:00:00.000Z'));

    expect(capture.sweeps).toHaveLength(1);
    expect(capture.cancellationSweeps).toHaveLength(1);
  });
});
