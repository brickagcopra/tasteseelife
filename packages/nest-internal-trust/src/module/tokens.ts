/**
 * DI tokens for the trust-header guard module.
 *
 * Exported as symbols so a host application can resolve the
 * configured options or override the guard for tests via
 * `Test.createTestingModule(...).overrideProvider(TRUST_HEADER_OPTIONS_TOKEN)`.
 */
export const TRUST_HEADER_OPTIONS_TOKEN = Symbol.for('@taste-and-see/nest-internal-trust:options');
