import { describe, expect, it } from 'vitest';

import { MemoryRecipesController } from './memory-recipes.controller';

/**
 * Controller-level wiring assertions for `MemoryRecipesController`
 * (TS-044-followup-1).
 *
 * Today this file covers only the `@Idempotent()` metadata wiring — the
 * service-layer tests in `services/memory-recipes.service.test.ts`
 * carry the behavioural coverage. Mirrors `intake.controller.test.ts`.
 */
describe('MemoryRecipesController idempotency wiring (TS-044-followup-1)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/seniors/:seniorId/memory-recipes as @Idempotent()', () => {
    const handler = MemoryRecipesController.prototype.create as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks PATCH /api/v1/seniors/:seniorId/memory-recipes/:recipeId as @Idempotent()', () => {
    const handler = MemoryRecipesController.prototype.update as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks DELETE /api/v1/seniors/:seniorId/memory-recipes/:recipeId as @Idempotent()', () => {
    const handler = MemoryRecipesController.prototype.remove as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark GET /api/v1/seniors/:seniorId/memory-recipes (read-only)', () => {
    // Read endpoints stay zero-cost (no Redis round-trip).
    const handler = MemoryRecipesController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});
