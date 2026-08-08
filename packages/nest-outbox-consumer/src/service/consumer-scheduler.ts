import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import type { ValidatedConsumerOptions } from '../config';
import { OUTBOX_CONSUMER_OPTIONS_TOKEN } from '../module/tokens';
import { OutboxConsumerService } from './consumer.service';

/**
 * Scheduler that drives the consumer's poll loop.
 *
 * Uses `setTimeout` re-arm (not `setInterval`) so a long-running cycle
 * never overlaps the next tick — exactly the same pattern the relay's
 * scheduler uses (`apps/workers/outbox-relay/src/relay/relay-scheduler.service.ts`).
 *
 * Lifecycle:
 *   - `onApplicationBootstrap` — call the consumer's `bootstrap()`
 *     (idempotent XGROUP CREATE for every subscribed stream) and arm
 *     the first timer.
 *   - tick: `pollOnce()` runs; on completion, the scheduler re-arms
 *     the timer with `pollIntervalMs`. Re-arm happens in `finally` so
 *     a thrown cycle stays alive.
 *   - `onApplicationShutdown` — clear the pending timer + await any
 *     in-flight cycle so the Kubernetes SIGTERM drains cleanly.
 *
 * **Why `onApplicationBootstrap` and not `onModuleInit` (TS-505d2).**
 * `OutboxConsumerService.bootstrap()` creates a Redis consumer group
 * for each *registered* handler, and handlers register from feature
 * modules' `onModuleInit`. Nest runs `onModuleInit` in module
 * dependency order, and this scheduler lives in the SDK module that
 * every feature module depends on — so scheduling `bootstrap()` on the
 * same hook meant **the SDK always initialised first and the handler
 * set was always empty**. No consumer group was created, `pollOnce`
 * had nothing to read, and every subsequent `registerHandler` logged
 * "called after bootstrap" into a log nobody watched. `booking.completed`
 * and `subscription.activated` were consumed by nothing in any
 * environment: no commission was recognised and no provider payable
 * was ever raised.
 *
 * `onApplicationBootstrap` is the hook Nest guarantees runs after
 * *every* module's `onModuleInit`, which is the ordering the split
 * between `registerHandler` and `bootstrap` was designed around all
 * along. The "called after bootstrap" warning stays — it is now
 * reachable only by a handler registered from a genuinely late hook,
 * which is the case it was written for.
 *
 * The poll loop is the only piece that calls `pollOnce`; tests can
 * still invoke `pollOnce()` directly on the OutboxConsumerService to
 * exercise behaviour deterministically without involving the scheduler.
 */
@Injectable()
export class OutboxConsumerScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('OutboxConsumerScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly consumer: OutboxConsumerService,
    @Inject(OUTBOX_CONSUMER_OPTIONS_TOKEN)
    private readonly options: ValidatedConsumerOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.consumer.bootstrap();
    } catch (e) {
      this.log.error(
        `bootstrap failed; scheduler will NOT start (the service still boots so health probes can surface the failure): ${messageOf(e)}`,
      );
      return;
    }
    this.running = true;
    this.arm();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /**
   * Test seam: directly trigger a tick (skipping the timer arm). Used
   * by unit tests to verify the cycle's effects against a fake consumer.
   */
  async tickNow(): Promise<void> {
    await this.tick();
  }

  private arm(): void {
    if (!this.running || this.shuttingDown) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.shuttingDown) return;
    const cycle = this.consumer
      .pollOnce()
      .then((summary) => {
        if (summary.entriesRead > 0) {
          this.log.debug(
            `tick read=${summary.entriesRead} succeeded=${summary.succeeded} failed=${summary.failed} deadLettered=${summary.deadLettered} skipped=${summary.skippedAlreadyProcessed}`,
          );
        }
      })
      .catch((e: unknown) => {
        this.log.error(`unhandled error in pollOnce; cycle continues: ${messageOf(e)}`);
      })
      .finally(() => {
        this.inFlight = null;
        this.arm();
      });
    this.inFlight = cycle;
    await cycle;
  }
}

function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
}
