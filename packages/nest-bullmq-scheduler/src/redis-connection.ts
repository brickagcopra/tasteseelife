import type { ConnectionOptions } from 'bullmq';

/**
 * Decompose a `REDIS_URL` into BullMQ connection options.
 *
 * BullMQ constructs (and owns) its own ioredis clients from these — the
 * queue gets one, the worker gets its own blocking connection — and
 * `close()` tears both down. We hand it OPTIONS rather than pre-built
 * ioredis instances because bullmq bundles its own ioredis whose instance
 * type is not assignable from the workspace's pinned ioredis 5.4.1
 * (declaration-level skew only, but the options form avoids the cast
 * entirely).
 *
 * `maxRetriesPerRequest: null` is BullMQ's hard requirement for worker
 * connections — a worker's blocking read must not be abandoned after N
 * retries, or the worker silently stops consuming.
 *
 * Verbatim from the two service-local copies this package replaces
 * (TS-293 service-identity, TS-308a service-booking).
 */
export function redisConnectionOptionsFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const dbSegment = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username !== '' ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password !== '' ? { password: decodeURIComponent(url.password) } : {}),
    ...(dbSegment !== '' ? { db: Number(dbSegment) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
