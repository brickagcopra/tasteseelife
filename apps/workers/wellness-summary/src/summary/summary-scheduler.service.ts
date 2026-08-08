import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { resolvePeriod, shouldRunNow } from './schedule';
import { SummaryOrchestratorService } from './summary-orchestrator.service';

/**
 * Drives the monthly wellness-summary cadence (TS-235). Mirrors the
 * outbox-relay `RelayScheduler` lifecycle shape:
 *
 *   - On module-init, arm a `setTimeout`-based re-schedule (NOT
 *     `setInterval`) so a long-running batch never overlaps the next
 *     tick. The re-arm happens in a finally block so even a thrown run
 *     keeps the loop alive.
 *   - Each tick checks `shouldRunNow` (day-of-month + hour-of-day window,
 *     UTC) against the in-process `lastRunPeriod` guard. When the window
 *     is reached and this period hasn't run, fire the batch once and
 *     stamp `lastRunPeriod`. Deterministic dispatch idempotency keys make
 *     a re-run after a restart harmless.
 *   - The kill-switch (`WELLNESS_SUMMARY_ENABLED`) short-circuits every
 *     tick to a no-op without disarming the loop.
 *   - On shutdown, clear the timer and await any in-flight run.
 *
 * The scheduler is excluded from unit-test coverage of the timer loop
 * (the orchestrator + the pure `shouldRunNow` helper carry the logic);
 * tests invoke `runIfDue` directly.
 */
@Injectable()
export class SummaryScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(SummaryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private lastRunPeriod: string | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly orchestrator: SummaryOrchestratorService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      {
        enabled: this.env.WELLNESS_SUMMARY_ENABLED,
        runDayOfMonth: this.env.WELLNESS_SUMMARY_RUN_DAY_OF_MONTH,
        runHourUtc: this.env.WELLNESS_SUMMARY_RUN_HOUR_UTC,
        tickMs: this.env.WELLNESS_SUMMARY_SCHEDULER_TICK_MS,
      },
      'wellness-summary scheduler armed',
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
   * Run the batch if the cadence window is due. Public so tests drive it
   * directly without the timer. Returns whether a run fired.
   */
  async runIfDue(now: Date = new Date()): Promise<boolean> {
    if (!this.env.WELLNESS_SUMMARY_ENABLED) return false;
    const due = shouldRunNow({
      now,
      runDayOfMonth: this.env.WELLNESS_SUMMARY_RUN_DAY_OF_MONTH,
      runHourUtc: this.env.WELLNESS_SUMMARY_RUN_HOUR_UTC,
      lastRunPeriod: this.lastRunPeriod,
    });
    if (!due) return false;

    const period = resolvePeriod(now);
    // Stamp BEFORE the run so a slow batch overlapping the next tick
    // doesn't double-fire; idempotency keys cover the crash-after-stamp
    // case (a restart re-runs, every dispatch replays).
    this.lastRunPeriod = period.periodKey;
    try {
      await this.orchestrator.runForPeriod(period);
    } catch (err) {
      this.log.error(`wellness-summary run threw: ${errMessage(err)}`);
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopping) return;

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
          this.env.WELLNESS_SUMMARY_SCHEDULER_TICK_MS,
        );
        this.timer.unref?.();
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
