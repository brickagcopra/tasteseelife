import { describe, expect, it } from 'vitest';

import { SeniorPreferencesController } from './senior-preferences.controller';

/**
 * Controller-level wiring assertions for `SeniorPreferencesController`
 * (TS-044-followup-1).
 *
 * Today this file covers only the `@Idempotent()` metadata wiring — the
 * service-layer tests in `services/senior-preferences.service.test.ts`
 * carry the behavioural coverage. Mirrors `intake.controller.test.ts`.
 */
describe('SeniorPreferencesController idempotency wiring (TS-044-followup-1)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PATCH /api/v1/seniors/:seniorId/preferences as @Idempotent()', () => {
    const handler = SeniorPreferencesController.prototype.bulkUpsert as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark GET /api/v1/seniors/:seniorId/preferences (read-only)', () => {
    // Read endpoints stay zero-cost (no Redis round-trip).
    const handler = SeniorPreferencesController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});
