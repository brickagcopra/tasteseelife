import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { AggregationOrchestratorService } from './aggregation-orchestrator.service';
import { previousUtcDayKey, shouldRunNow, utcDayKey } from './schedule';

/**
 * Drives the nightly analytics-aggregator cadence (TS-217-prep-3b). Mirrors the
 * accounting-metrics / outbox-relay / wellness-summary / identity-janitor
 * lifecycle shape — the platform's established scheduled-worker idiom:
 *
 *   - On module-init, arm a `setTimeout`-based re-schedule (NOT `setInterval`)
 *     so a long-running compute never overlaps the next tick. The re-arm
 *     happens in a finally block so even a thrown run keeps the loop alive.
 *   - Each tick checks `shouldRunNow` (run-hour window, UTC) against the
 *     in-process `lastRunDayKey` guard (keyed on TODAY). When the window is
 *     reached and this day hasn't run, fire the aggregation once for the
 *     PREVIOUS complete UTC day and stamp `lastRunDayKey`. The date-keyed
 *     idempotency key makes a re-run after a restart harmless.
 *   - The kill-switch (`ANALYTICS_AGGREGATOR_ENABLED`) short-circuits every
 *     tick to a no-op without disarming the loop (CLAUDE.md §11).
 *   - On shutdown, clear the timer and await any in-flight run so a Kubernetes
 *     SIGTERM drains cleanly.
 *
 * **Previous-day targeting.** The guard keys on `utcDayKey(now)` (today, so the
 * job fires once per calendar day) but the work targets `previousUtcDayKey(now)`
 * — the complete day to aggregate. This differs from the accounting-metrics
 * worker, whose point-in-time snapshot targets "today"; documented in
 * `schedule.ts`.
 *
 * Why a `setTimeout` loop and not BullMQ: the compute is idempotent +
 * absolute-date keyed, so a missed or duplicated run is harmless — there is no
 * job-durability or retry requirement a queue would satisfy. Matching the
 * existing worker idiom keeps the fleet uniform (CLAUDE.md §16 — default to the
 * simpler / consistent option, trade-off documented).
 *
 * The timer loop is excluded from unit-test coverage (the sibling-worker
 * convention); `runIfDue` is public so tests drive a run deterministically.
 */
@Injectable()
export class AggregationScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(AggregationScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private lastRunDayKey: string | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly orchestrator: AggregationOrchestratorService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      {
        enabled: this.env.ANALYTICS_AGGREGATOR_ENABLED,
        runHourUtc: this.env.ANALYTICS_AGGREGATOR_RUN_HOUR_UTC,
        tickMs: this.env.ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS,
      },
      'analytics-aggregator scheduler armed',
    );
    this.running = true;
    void this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight !== undefined) {
      try {
        await this.inFlight;
      } catch (err) {
        this.log.warn(`in-flight run errored during shutdown: ${errMessage(err)}`);
      }
    }
  }

  /**
   * Run the aggregation if the cadence window is due. Public so tests drive it
   * directly without the timer. Returns whether a run fired.
   */
  async runIfDue(now: Date = new Date()): Promise<boolean> {
    if (!this.env.ANALYTICS_AGGREGATOR_ENABLED) {
      return false;
    }
    const due = shouldRunNow({
      now,
      runHourUtc: this.env.ANALYTICS_AGGREGATOR_RUN_HOUR_UTC,
      lastRunDayKey: this.lastRunDayKey,
    });
    if (!due) {
      return false;
    }

    // Stamp the guard with TODAY (one run per calendar day) BEFORE the run so a
    // slow compute overlapping the next tick doesn't double-fire; the
    // date-keyed idempotency covers the crash-after-stamp case.
    this.lastRunDayKey = utcDayKey(now);
    // Aggregate the PREVIOUS complete UTC day.
    await this.orchestrator.runForDay(previousUtcDayKey(now));
    return true;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopping) {
      return;
    }

    const cycle = this.runIfDue().then(
      () => undefined,
      (err: unknown) => {
        this.log.error(`scheduler tick threw unexpectedly: ${errMessage(err)}`);
      },
    );
    this.inFlight = cycle;
    try {
      await cycle;
    } finally {
      this.inFlight = undefined;
      if (this.running && !this.stopping) {
        this.timer = setTimeout(
          () => void this.tick(),
          this.env.ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS,
        );
        this.timer.unref?.();
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
