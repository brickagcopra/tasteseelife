import { randomUUID } from 'node:crypto';

/**
 * Test-data helpers (TS-505, CLAUDE.md §9.3 — "test data via factories, not
 * fixtures-as-truth").
 *
 * Identifiers are unique per call rather than per run. The suite normally
 * starts from a freshly migrated database, but `E2E_RESET_DATABASE=false` is a
 * supported iteration mode, and a fixed address would make the second run of a
 * signup spec fail with a 409 that has nothing to do with the code under test.
 *
 * The `example.test` domain is reserved by RFC 2606 — no address minted here
 * can ever route, so a service that grows an email side effect cannot mail a
 * real person from a test run.
 */

/** A unique, non-routable address. `label` shows which spec minted it. */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomUUID()}@example.test`;
}

/** A unique `Idempotency-Key` (CLAUDE.md §3.3). */
export function idempotencyKey(): string {
  return randomUUID();
}
