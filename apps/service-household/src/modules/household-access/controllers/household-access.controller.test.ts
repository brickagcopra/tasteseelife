import { describe, expect, it } from 'vitest';

import { HouseholdAccessController } from './household-access.controller';

/**
 * Controller-level wiring assertions for `HouseholdAccessController`
 * (TS-044-followup-1).
 *
 * Today this file covers only the `@Idempotent()` metadata wiring — the
 * service-layer tests in `services/household-access.service.test.ts`
 * carry the behavioural coverage. Mirrors `intake.controller.test.ts`.
 */
describe('HouseholdAccessController idempotency wiring (TS-044-followup-1)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PUT /api/v1/households/:householdId/access-instructions as @Idempotent()', () => {
    const handler = HouseholdAccessController.prototype.upsert as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });
});
