/**
 * Local `Result<T, E>` helper. Same discriminated-union shape as the
 * helpers in service-identity / service-subscription / service-provider
 * / service-booking — lift to `packages/result` when a fifth consumer
 * arrives (CLAUDE.md §2.1).
 */
export type Result<T, E> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ kind: 'ok', value });
export const err = <E>(error: E): Result<never, E> => ({ kind: 'err', error });
