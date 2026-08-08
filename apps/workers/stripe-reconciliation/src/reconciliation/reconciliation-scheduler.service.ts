import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { ReconciliationOrchestratorService } from './reconciliation-orchestrator.service';
import { shouldRunNow, utcDayKey } from './schedule';

/**
 * Drives the nightly stripe-reconciliation cadence (TS-261). Mirrors the
 * accounting-metrics / outbox-relay / identity-janitor lifecycle shape — the
 * platform's established scheduled-worker idiom:
 *
 *   - On module-init, arm a `setTimeout`-based re-schedule (NOT
 *     `setInterval`) so a long-running run never overlaps the next tick. The
 *     re-arm happens in a finally block so even a thrown run keeps the loop
 *     alive.
 *   - Each tick checks `shouldRunNow` (run-hour window, UTC) against the
 *     in-process `lastRunDayKey` guard. When the window is reached and this
 *     day hasn't run, fire the run once and stamp `lastRunDayKey`. The
 *     date-keyed idempotency makes a re-run after a restart harmless.
 *   - The kill-switch (`STRIPE_RECONCILIATION_ENABLED`) short-circuits every
 *     tick to a no-op without disarming the loop (CLAUDE.md §11).
 *   - On shutdown, clear the timer and await any in-flight run so a
 *     Kubernetes SIGTERM drains cleanly.
 *
 * Why a `setTimeout` loop and not BullMQ: the run is idempotent + absolute-
 * date keyed (the `(reconciliation_date, category)` UNIQUE upsert on the
 * accounting side), so a missed or duplicated run is harmless — there is no
 * job-durability or retry requirement a queue would satisfy. Matching the
 * existing worker idiom keeps the fleet uniform (CLAUDE.md §16 — default to
 * the simpler / consistent option). The accounting-metrics worker carries
 * the identical rationale for TS-260.
 *
 * The timer loop is excluded from unit-test coverage (the same convention as
 * the sibling workers); `runIfDue` is public so tests drive a run
 * deterministically.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(ReconciliationScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private lastRunDayKey: string | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly orchestrator: ReconciliationOrchestratorService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      {
        enabled: this.env.STRIPE_RECONCILIATION_ENABLED,
        runHourUtc: this.env.STRIPE_RECONCILIATION_RUN_HOUR_UTC,
        tickMs: this.env.STRIPE_RECONCILIATION_SCHEDULER_TICK_MS,
      },
      'stripe-reconciliation scheduler armed',
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
   * Run the reconciliation if the cadence window is due. Public so tests
   * drive it directly without the timer. Returns whether a run fired.
   */
  async runIfDue(now: Date = new Date()): Promise<boolean> {
    if (!this.env.STRIPE_RECONCILIATION_ENABLED) {
      return false;
    }
    const due = shouldRunNow({
      now,
      runHourUtc: this.env.STRIPE_RECONCILIATION_RUN_HOUR_UTC,
      lastRunDayKey: this.lastRunDayKey,
    });
    if (!due) {
      return false;
    }

    const dayKey = utcDayKey(now);
    // Stamp BEFORE the run so a slow run overlapping the next tick doesn't
    // double-fire; the date-keyed idempotency covers the crash-after-stamp
    // case (a restart re-runs, the run replays).
    this.lastRunDayKey = dayKey;
    await this.orchestrator.runForDay(dayKey);
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
          this.env.STRIPE_RECONCILIATION_SCHEDULER_TICK_MS,
        );
        this.timer.unref?.();
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
