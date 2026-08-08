/**
 * DI tokens for the idempotency module. Symbols are used (not class
 * tokens) so consumers cannot accidentally instantiate the providers
 * via a `new` call — only the module factory wires them up.
 */
export const IDEMPOTENCY_OPTIONS_TOKEN = Symbol.for('@taste-and-see/nest-idempotency:options');
export const IDEMPOTENCY_STORE_TOKEN = Symbol.for('@taste-and-see/nest-idempotency:store');
export const IDEMPOTENCY_REDIS_TOKEN = Symbol.for('@taste-and-see/nest-idempotency:redis');
