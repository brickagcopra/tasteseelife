import { z } from 'zod';

/**
 * Configuration accepted by `TenantContextModule.forRoot`.
 *
 * `serviceName` and `environment` echo into log lines emitted by the
 * Prisma extension when a query lands without a `RequestContext` — the
 * operator scanning a warning needs to know which service surfaced it.
 *
 * `enforcement` controls what happens when an unscoped Prisma operation
 * is observed:
 *
 *   `audit`  — log a warning and proceed (the Phase-1 default). Lets
 *              services adopt the SDK without breaking any existing
 *              code paths. Operators ramp from `audit` → `enforce`
 *              per service once the warning count goes to zero.
 *
 *   `enforce` — throw `MissingRequestContextError` so the query never
 *              hits Postgres. CLAUDE.md §3.2 + §17.10 — the long-term
 *              destination for every service.
 *
 * `unscopedModels` lists Prisma model names that the gate should always
 * allow regardless of context state. Catalog tables (Plan,
 * ChartOfAccount, ServiceCatalog), platform-owned registries, and any
 * model that genuinely has no tenant axis live here.
 *
 * `unscopedOperations` lists Prisma top-level operations exempt from the
 * gate — practically only the raw-query family. Raw queries are an
 * explicit escape hatch (CLAUDE.md §4.1 lets services use them when
 * Prisma's typed API can't express a query); they cannot be tenant-
 * scoped at the SDK layer.
 *
 * `actorResolver` is the bridge from the consumer's request shape to the
 * `RequestContext`. The default reads `request.requestContext` directly
 * (the shape every Taste & See `AccessTokenGuard` already populates on
 * the Express request). Override if a service uses a different request
 * augmentation (e.g. Fastify, or a different property name).
 */
export interface TenantContextModuleOptions {
  readonly serviceName: string;
  readonly environment: string;
  readonly enforcement?: TenantContextEnforcement;
  readonly unscopedModels?: readonly string[];
  readonly unscopedOperations?: readonly string[];
  readonly actorResolver?: ActorResolver;
}

export type TenantContextEnforcement = 'audit' | 'enforce';

export type ActorResolver = (request: ActorRequest) => unknown;

/**
 * The slim subset of an Express request the default actor resolver
 * accesses. Consumers passing a Fastify request or a custom shape can
 * supply their own `actorResolver` callback.
 */
export interface ActorRequest {
  readonly requestContext?: unknown;
}

/**
 * Always-allowed raw-SQL operation names. Prisma uses these names in
 * the `$allOperations` payload — kept in sync with Prisma 5.x. The
 * extension reads `unscopedOperations` to decide whether to bypass the
 * gate; this constant is the curated default that consumers can extend
 * via the module option.
 */
export const DEFAULT_UNSCOPED_OPERATIONS: readonly string[] = Object.freeze([
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  '$runCommandRaw',
]);

const IdentifierLikeSchema = z
  .string()
  .min(1, 'must be a non-empty string')
  .max(200, 'must be ≤200 characters');

const EnforcementSchema = z.enum(['audit', 'enforce']);

/**
 * Validate options at module construction time. Bootstrap-time misconfig
 * should fail loudly — silent fallback to defaults would mask a
 * deployment that thinks it has tenant-scoping wired but doesn't.
 */
export function validateOptions(options: TenantContextModuleOptions): ValidatedOptions {
  const issues: string[] = [];

  if (!IdentifierLikeSchema.safeParse(options.serviceName).success) {
    issues.push('serviceName must be a non-empty string ≤200 chars');
  }
  if (!IdentifierLikeSchema.safeParse(options.environment).success) {
    issues.push('environment must be a non-empty string ≤200 chars');
  }

  const enforcement = options.enforcement ?? 'audit';
  if (!EnforcementSchema.safeParse(enforcement).success) {
    issues.push(`enforcement must be one of: audit, enforce (got ${JSON.stringify(enforcement)})`);
  }

  const unscopedModels = options.unscopedModels ?? [];
  if (
    !Array.isArray(unscopedModels) ||
    unscopedModels.some((m) => typeof m !== 'string' || m.length === 0)
  ) {
    issues.push('unscopedModels must be an array of non-empty strings');
  }

  const unscopedOperations = options.unscopedOperations ?? DEFAULT_UNSCOPED_OPERATIONS;
  if (
    !Array.isArray(unscopedOperations) ||
    unscopedOperations.some((o) => typeof o !== 'string' || o.length === 0)
  ) {
    issues.push('unscopedOperations must be an array of non-empty strings');
  }

  const actorResolver = options.actorResolver ?? defaultActorResolver;
  if (typeof actorResolver !== 'function') {
    issues.push('actorResolver must be a function');
  }

  if (issues.length > 0) {
    throw new TenantContextConfigError(issues);
  }

  return {
    serviceName: options.serviceName,
    environment: options.environment,
    enforcement,
    unscopedModels: Object.freeze([...unscopedModels]),
    unscopedOperations: Object.freeze([...unscopedOperations]),
    actorResolver,
  };
}

export interface ValidatedOptions {
  readonly serviceName: string;
  readonly environment: string;
  readonly enforcement: TenantContextEnforcement;
  readonly unscopedModels: readonly string[];
  readonly unscopedOperations: readonly string[];
  readonly actorResolver: ActorResolver;
}

export class TenantContextConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`@taste-and-see/nest-prisma-tenant-scope: invalid options — ${issues.join('; ')}`);
    this.name = 'TenantContextConfigError';
  }
}

function defaultActorResolver(request: ActorRequest): unknown {
  return request.requestContext;
}
