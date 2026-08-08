import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { MediaProcessorService } from './media-processor.service';
import { JOB_SOURCE_TOKEN, type JobSourcePort } from './ports';

/**
 * Drives the media-processor's drain cadence. Mirrors the
 * identity-janitor `JanitorScheduler` / outbox-relay `RelayScheduler`
 * lifecycle — the platform's established scheduled-worker idiom:
 *
 *   - On module-init, arm a `setTimeout`-based re-schedule (NOT
 *     `setInterval`) so a long-running batch never overlaps the next
 *     tick. The re-arm happens in a finally so even a thrown drain keeps
 *     the loop alive.
 *   - Each tick claims up to `MEDIA_PROCESSOR_BATCH_SIZE` jobs from the
 *     job source and processes each when `MEDIA_PROCESSOR_ENABLED` is
 *     true; otherwise the tick is a no-op that still re-arms (kill-switch
 *     without disarming the loop — CLAUDE.md §11).
 *   - On shutdown, clear the timer and await the in-flight drain so a
 *     Kubernetes SIGTERM completes the current batch cleanly.
 *
 * Why a `setTimeout` loop and not BullMQ directly here: the Phase-1 job
 * source is an in-memory stub (the live S3-event → BullMQ source is
 * TS-201-followup-2). When that lands, the BullMQ consumer replaces the
 * `claim` poll; the per-job `MediaProcessorService.process` call is
 * unchanged. Matching the sibling workers' timer idiom keeps the worker
 * fleet uniform (CLAUDE.md §16 — default to the consistent option).
 *
 * The timer loop is excluded from unit-test coverage (sibling-worker
 * convention); `runOnce` is public so tests drive a drain deterministically.
 */
@Injectable()
export class ProcessorScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(ProcessorScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(JOB_SOURCE_TOKEN) private readonly jobSource: JobSourcePort,
    private readonly processor: MediaProcessorService,
  ) {}

  onModuleInit(): void {
    this.log.log(
      {
        enabled: this.env.MEDIA_PROCESSOR_ENABLED,
        intervalMs: this.env.MEDIA_PROCESSOR_INTERVAL_MS,
        batchSize: this.env.MEDIA_PROCESSOR_BATCH_SIZE,
      },
      'media-processor scheduler armed',
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
        this.log.warn(`in-flight drain errored during shutdown: ${errMessage(err)}`);
      }
    }
  }

  /**
   * Claim + process one batch if the kill-switch is on. Public so tests
   * drive it without the timer. Returns the number of jobs processed.
   */
  async runOnce(): Promise<number> {
    if (!this.env.MEDIA_PROCESSOR_ENABLED) return 0;
    const jobs = await this.jobSource.claim(this.env.MEDIA_PROCESSOR_BATCH_SIZE);
    if (jobs.length === 0) return 0;

    let ready = 0;
    let rejected = 0;
    let failed = 0;
    let emitError = 0;
    for (const job of jobs) {
      const result = await this.processor.process(job);
      switch (result.outcome) {
        case 'ready':
          ready += 1;
          break;
        case 'rejected':
          rejected += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'emit_error':
          emitError += 1;
          break;
        case 'missing_object':
          break;
      }
    }
    this.log.log(
      { processed: jobs.length, ready, rejected, failed, emitError },
      'media-processor drain complete',
    );
    return jobs.length;
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
        this.timer = setTimeout(() => void this.tick(), this.env.MEDIA_PROCESSOR_INTERVAL_MS);
        this.timer.unref?.();
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
