/**
 * Injection tokens for `@taste-and-see/nest-prisma-tenant-scope`.
 *
 * Tokens are unique symbols rather than strings so a typo at the
 * consumer's `@Inject(...)` site is a TS error (a stringly-typed token
 * would resolve to undefined at runtime, the worst possible failure
 * mode for a security-sensitive piece of infra).
 */
export const TENANT_CONTEXT_STORE_TOKEN = Symbol('TENANT_CONTEXT_STORE_TOKEN');
export const TENANT_CONTEXT_OPTIONS_TOKEN = Symbol('TENANT_CONTEXT_OPTIONS_TOKEN');
