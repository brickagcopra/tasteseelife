/**
 * Thrown by the Prisma extension when a query lands without an active
 * `RequestContext` AND enforcement is `enforce`. CLAUDE.md §3.2 + §17.10.
 *
 * Carries metadata so the caller's exception filter can produce a
 * useful RFC 7807 body (the model + operation are safe to surface; the
 * actual query args are not — they may contain row PII).
 *
 * `internalCode` is the stable machine-readable label for log
 * aggregation; the human-readable `message` is for developer triage.
 */
export class MissingRequestContextError extends Error {
  public readonly internalCode = 'TENANT_SCOPE_MISSING_CONTEXT' as const;

  constructor(
    public readonly serviceName: string,
    public readonly model: string | undefined,
    public readonly operation: string,
  ) {
    super(
      `[${serviceName}] Prisma ${operation}${model ? ` on ${model}` : ''} attempted without a RequestContext in scope (CLAUDE.md §3.2). Wrap the call in TenantContextStore.runWith(ctx, ...) or runWithoutTenantContext(reason, ...).`,
    );
    this.name = 'MissingRequestContextError';
    // Maintain a clean stack trace on V8.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, MissingRequestContextError);
    }
  }
}
