import { z } from 'zod';

/**
 * Configuration accepted by `OutboxConsumerModule.forRoot`.
 *
 * `consumerGroup` is the Redis consumer-group name. By convention this is
 * the consuming service's name (e.g. `service-accounting`) so each service
 * has its own delivery position across every event stream. Two services
 * subscribing to the same stream form two independent consumer groups —
 * each receives every event exactly once (Redis Streams guarantee).
 *
 * `consumerName` is the per-pod consumer name inside the group. Concurrent
 * pods MUST use distinct consumer names (typically the pod hostname) so
 * Redis can track each pod's in-flight pending entries. If two pods share
 * a consumer name they trample each other's PEL claims. Default is
 * `default` for single-pod dev / tests; production wires this to
 * `process.env.HOSTNAME` (or equivalent) at module-init time.
 *
 * `streamPrefix` matches the relay-side `STREAM_NAME_PREFIX` env var
 * (default `events`) so the consumer reads from the same stream the
 * relay writes to.
 *
 * `maxAttempts` caps redelivery before a row is dead-lettered. Redis
 * Streams tracks delivery count via the Pending Entries List (PEL); the
 * SDK reads it via `XPENDING` and skips → XACK + dead-letter once the
 * count crosses the cap. Default = 10 (~10 minutes of redelivery at the
 * default 60s reclaim interval).
 *
 * `pollBlockMs` is the BLOCK argument to `XREADGROUP` — how long the
 * consumer waits for new entries before returning empty. Higher = less
 * Redis traffic; lower = lower shutdown latency. Default = 5000.
 *
 * `reclaimIdleMs` is the threshold for `XAUTOCLAIM` — entries pending in
 * the PEL longer than this get reclaimed from whoever delivered them (a
 * crashed pod's pending entries become eligible for redelivery to a
 * surviving pod). Default = 60000.
 *
 * `pollIntervalMs` is the gap between scheduler polls when BLOCK
 * returns empty. Default = 1000.
 *
 * `streamMaxLen` is purely informational — passed through to the
 * health probe so ops can correlate consumer lag against relay
 * stream-trim bounds. Not used by the consumer for any operational
 * behaviour. Default = 100_000 (matches the relay default).
 */
export interface OutboxConsumerModuleOptions {
  readonly consumerGroup: string;
  readonly consumerName?: string;
  readonly streamPrefix?: string;
  readonly maxAttempts?: number;
  readonly pollBlockMs?: number;
  readonly reclaimIdleMs?: number;
  readonly pollIntervalMs?: number;
  readonly streamMaxLen?: number;
  /**
   * Optional override of the clock used for timestamp defaults +
   * attempt records. Defaults to `() => new Date()`. Tests inject a
   * fake clock to make timestamp assertions deterministic.
   */
  readonly clock?: () => Date;
}

const NonEmptyStringSchema = z.string().min(1);
const IdentifierSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, {
  message:
    'must be an ASCII identifier (letters, digits, underscore, hyphen; not leading with a digit). Consumer group + name flow through Redis commands literally.',
});

/**
 * Validate options at module construction time. Bootstrap-time misconfig
 * should fail loudly — silent fallback would invite "consumer running
 * but receiving no events" surprise in prod.
 */
export function validateOptions(options: OutboxConsumerModuleOptions): ValidatedConsumerOptions {
  const issues: string[] = [];

  const groupParse = IdentifierSchema.safeParse(options.consumerGroup);
  if (!groupParse.success) {
    issues.push(`consumerGroup: ${groupParse.error.issues[0]?.message ?? 'invalid'}`);
  }

  const consumerName = options.consumerName ?? 'default';
  if (!NonEmptyStringSchema.safeParse(consumerName).success) {
    issues.push('consumerName must be a non-empty string');
  }

  const streamPrefix = options.streamPrefix ?? 'events';
  if (!NonEmptyStringSchema.safeParse(streamPrefix).success) {
    issues.push('streamPrefix must be a non-empty string');
  }

  const maxAttempts = options.maxAttempts ?? 10;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    issues.push('maxAttempts must be a positive integer');
  }

  const pollBlockMs = options.pollBlockMs ?? 5000;
  if (!Number.isInteger(pollBlockMs) || pollBlockMs < 0) {
    issues.push('pollBlockMs must be a non-negative integer');
  }

  const reclaimIdleMs = options.reclaimIdleMs ?? 60_000;
  if (!Number.isInteger(reclaimIdleMs) || reclaimIdleMs < 0) {
    issues.push('reclaimIdleMs must be a non-negative integer');
  }

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    issues.push('pollIntervalMs must be a non-negative integer');
  }

  const streamMaxLen = options.streamMaxLen ?? 100_000;
  if (!Number.isInteger(streamMaxLen) || streamMaxLen < 1) {
    issues.push('streamMaxLen must be a positive integer');
  }

  if (issues.length > 0) {
    throw new ConsumerConfigError(issues);
  }

  return {
    consumerGroup: options.consumerGroup,
    consumerName,
    streamPrefix,
    maxAttempts,
    pollBlockMs,
    reclaimIdleMs,
    pollIntervalMs,
    streamMaxLen,
    clock: options.clock ?? defaultClock,
  };
}

export interface ValidatedConsumerOptions {
  readonly consumerGroup: string;
  readonly consumerName: string;
  readonly streamPrefix: string;
  readonly maxAttempts: number;
  readonly pollBlockMs: number;
  readonly reclaimIdleMs: number;
  readonly pollIntervalMs: number;
  readonly streamMaxLen: number;
  readonly clock: () => Date;
}

export class ConsumerConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`@taste-and-see/nest-outbox-consumer: invalid options — ${issues.join('; ')}`);
    this.name = 'ConsumerConfigError';
  }
}

function defaultClock(): Date {
  return new Date();
}
