import { describe, expect, it } from 'vitest';

import { EmergencyContactsController } from './emergency-contacts.controller';

/**
 * Controller-level wiring assertions for `EmergencyContactsController`
 * (TS-044-followup-1).
 *
 * Today this file covers only the `@Idempotent()` metadata wiring — the
 * service-layer tests in `services/emergency-contacts.service.test.ts`
 * carry the behavioural coverage. Mirrors `intake.controller.test.ts`.
 */
describe('EmergencyContactsController idempotency wiring (TS-044-followup-1)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/households/:householdId/emergency-contacts as @Idempotent()', () => {
    const handler = EmergencyContactsController.prototype.create as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks PATCH /api/v1/households/:householdId/emergency-contacts/:contactId as @Idempotent()', () => {
    const handler = EmergencyContactsController.prototype.update as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('marks DELETE /api/v1/households/:householdId/emergency-contacts/:contactId as @Idempotent()', () => {
    const handler = EmergencyContactsController.prototype.remove as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark GET /api/v1/households/:householdId/emergency-contacts (read-only)', () => {
    // Read endpoints stay zero-cost (no Redis round-trip). Catches an
    // accidental class-level `@Idempotent()` that would apply to every
    // method.
    const handler = EmergencyContactsController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});
