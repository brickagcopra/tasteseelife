import { Queue, Worker } from 'bullmq';

import { redisConnectionOptionsFromUrl } from './redis-connection';

/**
 * The narrow slice of BullMQ a scheduled sweep actually drives.
 *
 * Injected behind a factory so unit tests substitute fakes: constructing a
 * real `Queue` or `Worker` opens Redis connections, which a unit test must
 * never do. Both services this package was extracted from had their own
 * copy of exactly this seam, and both used it for exactly this reason.
 */
export interface ScheduledSweepHandles {
  /** Upsert the repeatable job scheduler (idempotent across restarts and replicas). */
  scheduleSweep(intervalMs: number): Promise<void>;
  /** Close the worker (draining the in-flight job) then the queue + connections. */
  close(): Promise<void>;
}

export interface ScheduledSweepHandlesArgs {
  readonly redisUrl: string;
  /** CLAUDE.md §3.7-namespaced BullMQ prefix — `{env}:{service}:queue`. */
  readonly prefix: string;
  readonly queueName: string;
  /** Repeatable-job scheduler id. Stable across restarts; that is what makes the upsert a dedup. */
  readonly schedulerId: string;
  /** The sweep body. A throw marks the BullMQ job failed. */
  readonly processor: () => Promise<void>;
  /** Failure hook — surfaces BullMQ-level job failures into the host service's log. */
  readonly onFailed: (jobName: string | undefined, err: Error) => void;
}

export type ScheduledSweepHandlesFactory = (
  args: ScheduledSweepHandlesArgs,
) => ScheduledSweepHandles;

/**
 * Production factory — real BullMQ over the host's `REDIS_URL`. Keys land
 * under `{prefix}:{queueName}:*`, satisfying CLAUDE.md §3.7 with the queue
 * as the purpose segment.
 *
 * **`upsertJobScheduler` is the dedup mechanism.** Every replica upserts
 * the SAME scheduler id on boot, so Redis holds exactly one repeatable
 * definition and each tick produces exactly one job consumed by exactly
 * one worker — one sweep per interval cluster-wide, regardless of replica
 * count. Worker concurrency is pinned to 1 for the same reason: a sweep is
 * a singleton scan by design, and two concurrent passes over the same
 * window are at best duplicated work and at worst a race on whatever the
 * sweep writes.
 */
export const createBullMqScheduledSweepHandles: ScheduledSweepHandlesFactory = (args) => {
  const connection = redisConnectionOptionsFromUrl(args.redisUrl);
  const queue = new Queue(args.queueName, { connection, prefix: args.prefix });
  const worker = new Worker(
    args.queueName,
    async () => {
      await args.processor();
    },
    { connection, prefix: args.prefix, concurrency: 1 },
  );
  worker.on('failed', (job, err) => args.onFailed(job?.name, err));

  return {
    scheduleSweep: async (intervalMs: number): Promise<void> => {
      await queue.upsertJobScheduler(args.schedulerId, { every: intervalMs });
    },
    close: async (): Promise<void> => {
      await worker.close();
      await queue.close();
    },
  };
};
