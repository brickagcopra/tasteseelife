/**
 * Minimal `Result<T, E>` helper. Same shape as the one in
 * service-identity / service-subscription / service-provider — kept
 * local because no `packages/result` workspace package exists yet
 * (CLAUDE.md §2.1 Result/E discipline for fallible operations crossing
 * service or transaction boundaries). Lift when a fifth consumer
 * arrives.
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
