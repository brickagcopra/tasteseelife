/**
 * Module-options shape for `BullMqSchedulerModule.forRoot(...)`.
 *
 * The three inputs are exactly the values that differed between the two
 * service-local copies this package replaces, and nothing else: the
 * connection, and the two segments of the Redis key prefix.
 *
 * `serviceName` names the owning service (`service-identity`,
 * `service-booking`, …). It is REQUIRED and has no default: it is the
 * tenant-ish segment of the CLAUDE.md §3.7 key namespace, and a default
 * would mean one service's queues silently landing in another's keyspace.
 *
 * `environment` is the deployment environment (`NODE_ENV` in every host
 * today) and is the leading `{env}` segment of that same namespace. Also
 * required, for a sharper reason: a staging pod defaulting to the prod
 * prefix would consume prod's jobs.
 *
 * `redisUrl` is the shared `REDIS_URL`. BullMQ builds its own clients from
 * the decomposition (see `redisConnectionOptionsFromUrl`).
 */
export interface BullMqSchedulerModuleOptions {
  readonly serviceName: string;
  readonly environment: string;
  readonly redisUrl: string;
}

export interface ValidatedBullMqSchedulerOptions {
  readonly serviceName: string;
  readonly environment: string;
  readonly redisUrl: string;
  /** `{environment}:{serviceName}:queue` — derived here so no host re-derives it. */
  readonly prefix: string;
}

export class BullMqSchedulerConfigError extends Error {
  constructor(message: string) {
    super(`@taste-and-see/nest-bullmq-scheduler: ${message}`);
    this.name = 'BullMqSchedulerConfigError';
  }
}

function requireSegment(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BullMqSchedulerConfigError(`${field} must be a non-empty string`);
  }
  // A colon inside a segment would forge an extra level of the §3.7
  // namespace, so `{env}:{service}:queue` would no longer mean what it
  // reads as. Cheap to reject, impossible to debug once deployed.
  if (value.includes(':')) {
    throw new BullMqSchedulerConfigError(
      `${field} must not contain ':' — it is a segment of the Redis key namespace (received "${value}")`,
    );
  }
  return value;
}

/**
 * Validate + derive at module-definition time, so a misconfigured host
 * fails at boot rather than at the first tick — a sweep that never fires
 * is silent by nature, and silence is the failure mode these runners exist
 * to remove.
 */
export function validateBullMqSchedulerOptions(
  options: BullMqSchedulerModuleOptions,
): ValidatedBullMqSchedulerOptions {
  const serviceName = requireSegment(options.serviceName, 'serviceName');
  const environment = requireSegment(options.environment, 'environment');

  if (typeof options.redisUrl !== 'string' || options.redisUrl.trim().length === 0) {
    throw new BullMqSchedulerConfigError('redisUrl must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(options.redisUrl);
  } catch {
    throw new BullMqSchedulerConfigError('redisUrl must be a valid URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new BullMqSchedulerConfigError(
      `redisUrl must use redis: or rediss: (received protocol "${parsed.protocol}")`,
    );
  }

  return Object.freeze({
    serviceName,
    environment,
    redisUrl: options.redisUrl,
    prefix: `${environment}:${serviceName}:queue`,
  });
}
