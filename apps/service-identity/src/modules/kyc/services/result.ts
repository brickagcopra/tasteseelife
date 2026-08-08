/**
 * Tiny `Result<T, E>` helper used by service-identity's KYC boundary
 * code (CLAUDE.md §2.1: "Result<T, E> pattern for fallible operations
 * crossing service or transaction boundaries — do not throw across
 * those boundaries silently").
 *
 * Local to the module for the same reason service-subscription kept
 * its copy local: the shape is six lines and the only sane shared
 * home is a future `packages/result` workspace package that we don't
 * have yet. Lift when a fourth consumer arrives.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}
