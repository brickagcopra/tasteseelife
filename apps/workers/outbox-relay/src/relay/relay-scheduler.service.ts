import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import type { RelayWorkerService } from './relay-worker.service';

/**
 * Schedules the relay's poll cycle. Lives in a Nest-managed lifecycle
 * so deployments tear it down cleanly.
 *
 * Behaviour:
 *
 *   - On module-init, kick off the first cycle immediately + arm
 *     a `setTimeout`-based re-schedule (NOT `setInterval`) so a
 *     long-running cycle never overlaps with the next tick. The
 *     re-arm happens in a finally block — even a thrown cycle
 *     keeps the loop alive.
 *   - On application-shutdown, clear the pending timer and let any
 *     in-flight cycle finish before resolving. Tests bypass the
 *     scheduler by invoking `RelayWorkerService.pollOnce` directly.
 *
 * The skipped scheduler in tests is deliberate — covering a real
 * timer loop would force `vi.useFakeTimers` or `setTimeout` mocks,
 * which adds friction without catching anything the unit suite for
 * `RelayWorkerService.pollOnce` doesn't already cover.
 */
@Injectable()
export class RelayScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('RelayScheduler');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private inFlightCycle: Promise<void> | undefined;

  constructor(
    private readonly worker: RelayWorkerService,
    private readonly intervalMs: number,
  ) {}

  onModuleInit(): void {
    this.log.log(`scheduling relay poll every ${this.intervalMs}ms`);
    this.running = true;
    void this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlightCycle !== undefined) {
      try {
        await this.inFlightCycle;
      } catch (err) {
        this.log.warn(
          `relay scheduler: in-flight cycle errored during shutdown: ${(err as Error).message ?? String(err)}`,
        );
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopping) return;

    const cycle = (async () => {
      try {
        const results = await this.worker.pollOnce();
        const dispatched = results.reduce((s, r) => s + r.dispatched, 0);
        const failed = results.reduce((s, r) => s + r.failed, 0);
        const dead = results.reduce((s, r) => s + r.deadLettered, 0);
        if (dispatched > 0 || failed > 0 || dead > 0) {
          this.log.debug(
            `relay cycle: dispatched=${dispatched} failed=${failed} deadLettered=${dead}`,
          );
        }
      } catch (err) {
        this.log.error(`relay cycle threw unexpectedly: ${(err as Error).message ?? String(err)}`);
      }
    })();
    this.inFlightCycle = cycle;
    try {
      await cycle;
    } finally {
      this.inFlightCycle = undefined;
      if (this.running && !this.stopping) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
        // Allow the process to exit if no other handles remain.
        this.timer.unref?.();
      }
    }
  }
}
