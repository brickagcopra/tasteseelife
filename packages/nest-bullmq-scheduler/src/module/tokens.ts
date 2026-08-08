/**
 * DI token for the validated scheduler options (service name, environment,
 * Redis URL, and the derived §3.7 prefix).
 */
export const BULLMQ_SCHEDULER_OPTIONS_TOKEN = Symbol.for(
  '@taste-and-see/nest-bullmq-scheduler:options',
);

/**
 * DI token for the BullMQ handles factory.
 *
 * Bound to the real factory by `forRoot`, and overridable in a host's
 * tests via `Test.createTestingModule(...).overrideProvider(...)` so a
 * boot-level suite can exercise wiring without opening Redis.
 */
export const BULLMQ_SCHEDULER_HANDLES_FACTORY = Symbol.for(
  '@taste-and-see/nest-bullmq-scheduler:handles-factory',
);
