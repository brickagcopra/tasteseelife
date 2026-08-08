/**
 * Minimal `Result<T, E>` helper — local copy per the convention in
 * sibling modules' `result.ts`. Lift to `packages/result` when a
 * fifth consumer arrives (TS-200 is the fourth — applications,
 * certifications, profile + a sibling that will land soon).
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
