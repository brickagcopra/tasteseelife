import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { JanitorWorkerService } from './janitor-worker.service';

/**
 * Drives the janitor's sweep cadence. Mirrors the outbox-relay
 * `RelayScheduler` / wellness-summary `SummaryScheduler` lifecycle
 * shape — the platform's established scheduled-worker idiom:
 *
 *   - On module-init, arm a `setTimeout`-based re-schedule (NOT
 *     `setInterval`) so a long-running sweep never overlaps the next
 *     tick. The re-arm happens in a finally block so even a thrown
 *     sweep keeps the loop alive.
 *   - Each tick runs one sweep when `JANITOR_ENABLED` is true;
 *     otherwise the tick is a no-op that still re-arms (kill-switch
 *     without disarming the loop — CLAUDE.md §11).
 *   - On shutdown, clear the timer and await any in-flight sweep so a
 *     Kubernetes SIGTERM drains cleanly.
 *
 * Why a `setTimeout` loop and not BullMQ (TS-022-followup-3 named a
 * "BullMQ scheduled worker … or equivalent"): the prune is idempotent
 * and absolute-time-threshold based, so a missed or duplicated run is
 * harmless — there is no job-durability or retry requirement that a
 * queue would satisfy. The two existing platform workers (outbox-relay,
 * wellness-summary) both use this same timer idiom; matching it keeps
 * the worker fleet uniform rather than introducing a second scheduling
 * mechanism for a strictly simpler workload (CLAUDE.md §16 — default to
 * the simpler/consistent option, trade-off documented).
 *
 * The timer loop itself is excluded from unit-test coverage (the same
 * convention as the sibling workers); `runOnce` is public so tests
 * drive a sweep deterministically.
 */
@Injectable()
export class JanitorScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(JanitorScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly worker: JanitorWorkerService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      {
        enabled: this.env.JANITOR_ENABLED,
        intervalMs: this.env.JANITOR_INTERVAL_MS,
        batchSize: this.env.JANITOR_BATCH_SIZE,
        refreshTokenRetentionDays: this.env.REFRESH_TOKEN_RETENTION_DAYS,
        mfaChallengeRetentionDays: this.env.MFA_CHALLENGE_RETENTION_DAYS,
      },
      'identity-janitor scheduler armed',
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
        this.log.warn(`in-flight sweep errored during shutdown: ${errMessage(err)}`);
      }
    }
  }

  /**
   * Run one sweep if the kill-switch is on. Public so tests drive it
   * without the timer. Returns whether a sweep fired.
   */
  async runOnce(): Promise<boolean> {
    if (!this.env.JANITOR_ENABLED) return false;
    const results = await this.worker.sweepOnce();
    const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
    const errored = results.filter((r) => r.error !== undefined).length;
    if (deleted > 0 || errored > 0) {
      this.log.log(`sweep complete: deleted=${deleted} erroredTargets=${errored}`);
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopping) return;

    const cycle = this.runOnce().then(
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
        this.timer = setTimeout(() => void this.tick(), this.env.JANITOR_INTERVAL_MS);
        this.timer.unref?.();
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
