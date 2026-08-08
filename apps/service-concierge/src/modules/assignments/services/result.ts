/**
 * Minimal `Result<T, E>` helper — local copy per the convention in
 * sibling services' modules (service-provider's `result.ts`). Lift to a
 * shared `packages/result` when a wider set of consumers warrants it.
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
