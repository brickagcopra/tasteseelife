/**
 * DI token for the producing bounded context's name (e.g. `service-content`).
 *
 * A token rather than a constructor param type because vitest/esbuild has no
 * `emitDecoratorMetadata`, so a bare `producerService: string` constructor
 * parameter is invisible to Nest's DI at test time — the lesson TS-302b's
 * package-level DI tests recorded.
 */
export const AUDIT_PRODUCER_SERVICE = Symbol('AUDIT_PRODUCER_SERVICE');
