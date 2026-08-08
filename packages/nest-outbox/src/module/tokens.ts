/**
 * Injection tokens for `@taste-and-see/nest-outbox`. Tokens are unique
 * symbols rather than strings so a typo at the consumer's `@Inject(...)`
 * site is a TS error (a stringly-typed token would resolve to undefined
 * at runtime).
 */
export const OUTBOX_OPTIONS_TOKEN = Symbol('OUTBOX_OPTIONS_TOKEN');
export const OUTBOX_CLOCK_TOKEN = Symbol('OUTBOX_CLOCK_TOKEN');
export const OUTBOX_ID_GENERATOR_TOKEN = Symbol('OUTBOX_ID_GENERATOR_TOKEN');
