/**
 * Tiny `Result<T, E>` helper used by service-subscription's outbound
 * boundary code (CLAUDE.md §2.1: "Result<T, E> pattern for fallible
 * operations crossing service or transaction boundaries — do not throw
 * across those boundaries silently").
 *
 * Kept local to the service for now. Consolidate into `packages/result`
 * when a third service (likely service-payouts or service-accounting)
 * needs the same shape.
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
