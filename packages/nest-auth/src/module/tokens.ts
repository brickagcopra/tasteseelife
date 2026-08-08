/**
 * DI tokens for the `@taste-and-see/nest-auth` module.
 *
 * Exported as `Symbol.for(...)` so a host application can resolve the
 * configured options or override the guard for tests via
 * `Test.createTestingModule(...).overrideProvider(JWT_VERIFIER_OPTIONS_TOKEN)`.
 */
export const JWT_VERIFIER_OPTIONS_TOKEN = Symbol.for(
  '@taste-and-see/nest-auth:jwt-verifier-options',
);
