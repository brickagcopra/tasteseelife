import { z } from 'zod';

import type { IdempotencyStore } from './store/types';

/**
 * Configuration accepted by `IdempotencyModule.forRoot`.
 *
 * Two shapes:
 *
 *   `redis` — production. Either a `redisUrl` string (the module builds
 *             its own ioredis client) or a pre-built `redisClient`
 *             (consumers can share a client across modules).
 *
 *   `store` — explicit. Pass a fully-constructed `IdempotencyStore`
 *             implementation (e.g. `MemoryIdempotencyStore` for tests,
 *             a custom adapter for non-Redis backends).
 *
 * The `actorResolver` knob lets the consumer adapt the actor segment of
 * the Redis key (CLAUDE.md §3.7) to its own request shape — by default
 * it reads `request.requestContext.userId` (matching the
 * `AccessTokenGuard` contract in service-identity / service-household /
 * service-subscription), falls back to `request.user?.id`, and finally
 * to the literal `anonymous`.
 *
 * The `shouldCacheStatus` knob decides which HTTP status codes are
 * cached on completion. Default: cache 2xx + 3xx + 4xx, never 5xx
 * (5xx is treated as transient — re-invoking the handler may succeed).
 */
export interface IdempotencyModuleOptions {
  readonly environment: string;
  readonly serviceName: string;
  readonly ttlSeconds?: number;
  readonly inFlightTtlSeconds?: number;
  readonly actorResolver?: (request: ActorRequest) => string | null | undefined;
  readonly shouldCacheStatus?: (statusCode: number) => boolean;
  /**
   * One of:
   *
   *   `{ redisUrl: 'redis://...' }` — module builds and owns the ioredis
   *      client (lifecycle wired to the Nest module — disconnects on
   *      shutdown).
   *
   *   `{ redisClient }` — consumer-provided ioredis client (the module
   *      does NOT call `.quit()` — lifecycle remains the consumer's
   *      responsibility).
   *
   *   `{ store }` — explicit `IdempotencyStore` (production custom
   *      adapter, or `MemoryIdempotencyStore` for tests/dev).
   */
  readonly backend:
    | { readonly kind: 'redis-url'; readonly redisUrl: string }
    | { readonly kind: 'redis-client'; readonly redisClient: unknown }
    | { readonly kind: 'store'; readonly store: IdempotencyStore };
}

/**
 * The slim subset of an Express request the default actor resolver
 * accesses. Consumers pass their own request shape via the
 * `actorResolver` callback.
 */
export interface ActorRequest {
  readonly requestContext?: { readonly userId?: string | null };
  readonly user?: { readonly id?: string | null };
}

const PositiveIntegerSchema = z.number().int().positive();

/**
 * Validate options at module construction time. Bootstrap-time misconfig
 * should fail loudly — silent fallback would invite "no caching is
 * happening" surprise in prod.
 */
export function validateOptions(options: IdempotencyModuleOptions): ValidatedOptions {
  const issues: string[] = [];

  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    issues.push('environment must be a non-empty string');
  }
  if (typeof options.serviceName !== 'string' || options.serviceName.length === 0) {
    issues.push('serviceName must be a non-empty string');
  }

  const ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
  const inFlightTtlSeconds = options.inFlightTtlSeconds ?? 60;
  if (!PositiveIntegerSchema.safeParse(ttlSeconds).success) {
    issues.push('ttlSeconds must be a positive integer');
  }
  if (!PositiveIntegerSchema.safeParse(inFlightTtlSeconds).success) {
    issues.push('inFlightTtlSeconds must be a positive integer');
  }
  if (inFlightTtlSeconds > ttlSeconds) {
    issues.push('inFlightTtlSeconds must not exceed ttlSeconds');
  }

  if (options.backend.kind === 'redis-url') {
    const { redisUrl } = options.backend;
    if (typeof redisUrl !== 'string' || redisUrl.length === 0) {
      issues.push('backend.redisUrl must be a non-empty string');
    }
  } else if (options.backend.kind === 'redis-client') {
    if (options.backend.redisClient === null || options.backend.redisClient === undefined) {
      issues.push('backend.redisClient must be a constructed ioredis instance');
    }
  } else if (options.backend.kind === 'store') {
    const candidate = options.backend.store as Partial<IdempotencyStore>;
    if (typeof candidate?.claim !== 'function' || typeof candidate?.complete !== 'function') {
      issues.push('backend.store must implement IdempotencyStore (claim/complete/release)');
    }
  } else {
    issues.push(
      `backend.kind must be one of redis-url, redis-client, store (got ${JSON.stringify((options.backend as { kind?: unknown } | undefined)?.kind)})`,
    );
  }

  if (issues.length > 0) {
    throw new IdempotencyConfigError(issues);
  }

  return {
    environment: options.environment,
    serviceName: options.serviceName,
    ttlSeconds,
    inFlightTtlSeconds,
    actorResolver: options.actorResolver ?? defaultActorResolver,
    shouldCacheStatus: options.shouldCacheStatus ?? defaultShouldCacheStatus,
    backend: options.backend,
  };
}

export interface ValidatedOptions {
  readonly environment: string;
  readonly serviceName: string;
  readonly ttlSeconds: number;
  readonly inFlightTtlSeconds: number;
  readonly actorResolver: (request: ActorRequest) => string | null | undefined;
  readonly shouldCacheStatus: (statusCode: number) => boolean;
  readonly backend: IdempotencyModuleOptions['backend'];
}

export class IdempotencyConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`@taste-and-see/nest-idempotency: invalid options — ${issues.join('; ')}`);
    this.name = 'IdempotencyConfigError';
  }
}

function defaultActorResolver(req: ActorRequest): string | null {
  return req.requestContext?.userId ?? req.user?.id ?? null;
}

function defaultShouldCacheStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 500;
}
