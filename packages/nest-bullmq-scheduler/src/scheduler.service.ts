import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { type ScheduledSweepHandles, type ScheduledSweepHandlesFactory } from './handles';
import { BullMqSchedulerConfigError } from './module/options';
import type { ValidatedBullMqSchedulerOptions } from './module/options';
import { BULLMQ_SCHEDULER_HANDLES_FACTORY, BULLMQ_SCHEDULER_OPTIONS_TOKEN } from './module/tokens';

/** Scalar shapes admitted into the arm-time log line. No free text, no objects. */
export type SweepLogDetail = string | number | boolean | null;

/**
 * One repeatable sweep: a queue, a cadence, and a body.
 *
 * Everything here was per-service in the two copies this package replaces;
 * everything NOT here (connection, prefix, worker concurrency, scheduler
 * upsert semantics, shutdown) was verbatim and now lives in one place.
 */
export interface ScheduledSweepSpec {
  /** Queue name — also the purpose segment of the §3.7 key namespace. Unique per process. */
  readonly queueName: string;
  /**
   * Repeatable-job scheduler id. Defaults to `queueName`. Supply it only
   * to preserve an id already live in Redis: changing it leaves the old
   * repeatable definition behind, and the sweep then runs twice per
   * interval until someone prunes it by hand.
   */
  readonly schedulerId?: string;
  readonly intervalMs: number;
  /**
   * The kill switch, read by the host from its own env. `false` creates no
   * queue and no worker at all — which is what makes it usable during an
   * incident: ops turns a misbehaving sweep off with an env change rather
   * than a redeploy.
   */
  readonly enabled: boolean;
  /**
   * The NAME of the env var behind `enabled`, for the disabled-path log.
   * Required rather than optional because "this sweep is not running" is
   * only actionable if the operator reading the line knows which lever
   * turned it off.
   */
  readonly disabledBy: string;
  /** The sweep body. A throw marks the BullMQ job failed; the next tick retries. */
  readonly processor: () => Promise<void>;
  /** Extra configuration echoed on the arm-time log line (thresholds, windows, batch sizes). */
  readonly details?: Readonly<Record<string, SweepLogDetail>>;
}

/**
 * Owns the BullMQ queue + worker lifecycle for every in-service repeatable
 * sweep, inside the host's Nest lifecycle so a deployment tears them down
 * cleanly.
 *
 * **Why sweeps live inside their owning service rather than a worker app**
 * (the TS-293 rationale, which held again at TS-308a and again here): a
 * sweep needs its service's own Prisma client, and a standalone worker
 * would either reach across a schema boundary (CLAUDE.md §2.3) or force an
 * internal bulk API with no other caller.
 *
 * Observability per CLAUDE.md §10: info on arm and on the disabled path,
 * warn on a BullMQ-level job failure (the scheduler keeps its next tick),
 * warn on a close that raises during shutdown. Success/failure logging of
 * the sweep BODY belongs to the host — only the host knows what its own
 * counts mean.
 */
@Injectable()
export class BullMqSchedulerService implements OnApplicationShutdown {
  private readonly logger = new Logger(BullMqSchedulerService.name);
  private readonly handles = new Map<string, ScheduledSweepHandles>();

  constructor(
    @Inject(BULLMQ_SCHEDULER_OPTIONS_TOKEN)
    private readonly options: ValidatedBullMqSchedulerOptions,
    @Inject(BULLMQ_SCHEDULER_HANDLES_FACTORY)
    private readonly createHandles: ScheduledSweepHandlesFactory,
  ) {}

  /** The `{env}:{service}:queue` prefix every queue registered here lands under. */
  get prefix(): string {
    return this.options.prefix;
  }

  /** Whether a queue name is currently armed. Exposed for host boot assertions. */
  isScheduled(queueName: string): boolean {
    return this.handles.has(queueName);
  }

  /**
   * Arm one repeatable sweep. Idempotent in Redis (the scheduler upsert is
   * what makes replicas safe), but NOT idempotent in-process: registering
   * the same queue name twice would stand up a second worker on the same
   * queue and is rejected as the wiring bug it is.
   */
  async schedule(spec: ScheduledSweepSpec): Promise<void> {
    if (spec.queueName.trim().length === 0) {
      throw new BullMqSchedulerConfigError('queueName must be a non-empty string');
    }
    if (!Number.isInteger(spec.intervalMs) || spec.intervalMs <= 0) {
      throw new BullMqSchedulerConfigError(
        `intervalMs must be a positive integer (queue "${spec.queueName}")`,
      );
    }
    if (this.handles.has(spec.queueName)) {
      throw new BullMqSchedulerConfigError(
        `queue "${spec.queueName}" is already scheduled in this process`,
      );
    }

    if (!spec.enabled) {
      this.logger.log(
        { queue: spec.queueName, disabledBy: spec.disabledBy },
        `${spec.queueName} disabled via ${spec.disabledBy}=false — no queue created`,
      );
      return;
    }

    const handles = this.createHandles({
      redisUrl: this.options.redisUrl,
      prefix: this.options.prefix,
      queueName: spec.queueName,
      schedulerId: spec.schedulerId ?? spec.queueName,
      processor: spec.processor,
      onFailed: (jobName, err) => {
        this.logger.warn(
          { queue: spec.queueName, jobName: jobName ?? null, error: err.message },
          `${spec.queueName} job failed — next scheduled tick retries`,
        );
      },
    });
    this.handles.set(spec.queueName, handles);

    await handles.scheduleSweep(spec.intervalMs);
    this.logger.log(
      {
        queue: spec.queueName,
        prefix: this.options.prefix,
        intervalMs: spec.intervalMs,
        ...(spec.details ?? {}),
      },
      `${spec.queueName} sweep scheduled`,
    );
  }

  /**
   * Close every armed sweep. Each is closed independently and a raise is
   * swallowed with a warn: a Redis that has already gone away must not
   * block the rest of a shutdown, and the sweep is stateless — the next
   * boot upserts the same scheduler id back.
   *
   * Handles are dropped as they close, so a repeated shutdown is a no-op
   * rather than a double close.
   */
  async onApplicationShutdown(): Promise<void> {
    const entries = [...this.handles.entries()];
    this.handles.clear();
    for (const [queueName, handles] of entries) {
      try {
        await handles.close();
      } catch (error) {
        this.logger.warn(
          { queue: queueName, error: error instanceof Error ? error.message : 'unknown' },
          `${queueName} close raised during shutdown`,
        );
      }
    }
  }
}
