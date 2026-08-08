import { describe, expect, it } from 'vitest';

import { IntakeController } from './intake.controller';

/**
 * Controller-level wiring assertions for `IntakeController` (TS-044-followup-1).
 *
 * Today this file covers only the `@Idempotent()` metadata wiring — the
 * service-layer tests in `services/intake.service.test.ts` carry the
 * behavioural coverage. When TS-141's tenant-scoping middleware lands
 * (or controller-level integration tests follow in TS-031-followup-5),
 * additional describe blocks can slot in alongside the idempotency
 * wiring block below.
 */
describe('IntakeController idempotency wiring (TS-044-followup-1)', () => {
  // The IdempotencyInterceptor (provided globally by IdempotencyModule
  // in app.module.ts) reads this exact symbol when deciding whether to
  // engage the Redis-backed Idempotency-Key replay cache. The metadata
  // MUST be present on every write endpoint or a replayed request will
  // silently re-run the handler — defeating CLAUDE.md §3.3 / §17.5.
  //
  // We reference the symbol via `Symbol.for(...)` rather than importing
  // it from `@taste-and-see/nest-idempotency` so this test pins the
  // wire contract — a refactor that renames the symbol will fail here
  // first, before it can silently disable the cache.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PUT /api/v1/seniors/:seniorId/intake as @Idempotent()', () => {
    const handler = IntakeController.prototype.upsert as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });
});
