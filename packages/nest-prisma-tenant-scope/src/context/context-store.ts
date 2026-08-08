import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '@taste-and-see/auth-sdk';

/**
 * The shape held inside the AsyncLocalStorage. Two variants:
 *
 *   `scoped`  — a real `RequestContext` is in scope. The owning request
 *               was authenticated, the gateway / `AccessTokenGuard`
 *               populated it, and the interceptor seeded it here.
 *
 *   `exempt`  — the surrounding code is INTENTIONALLY running without a
 *               request context (boot-time data seeding, background
 *               worker, periodic janitor, migration script). The reason
 *               string is carried for log emission so an audit reader
 *               can see WHY the gate was bypassed.
 *
 * Note: the absence of a frame entirely (i.e. `store.current()` returns
 * `null`) is treated by the gate as "no context AT ALL" — different
 * from `exempt`, which is "context is missing on purpose".
 */
export type TenantContextFrame =
  | { readonly kind: 'scoped'; readonly context: RequestContext }
  | { readonly kind: 'exempt'; readonly reason: string };

/**
 * Wraps Node's `AsyncLocalStorage` for the tenant-scoping context.
 *
 * The store is a class (not a singleton) so consumers can construct
 * their own instance in tests; the production wiring is a single
 * instance provided via DI through `TENANT_CONTEXT_STORE_TOKEN`.
 *
 * Why bare `AsyncLocalStorage` instead of `nestjs-cls` (on the approved
 * list per CLAUDE.md §13)? The Phase-1 surface is tight enough that the
 * Nest-CLS dependency would add weight without paying for itself. The
 * existing low-dependency aesthetic in `nest-idempotency` / `nest-outbox`
 * is the codebase precedent. A future swap to `nestjs-cls` is additive
 * — the public API of this class (`current` / `run` / `runWith`) covers
 * what consumers see.
 */
export class TenantContextStore {
  private readonly storage: AsyncLocalStorage<TenantContextFrame>;

  constructor() {
    this.storage = new AsyncLocalStorage<TenantContextFrame>();
  }

  /**
   * Returns the currently-active frame, or `null` if no frame is in
   * scope. The Prisma extension reads this on every operation:
   *
   *   - `null`     → unscoped (gate decides based on enforcement mode +
   *                  per-model / per-operation allow-lists).
   *   - `scoped`   → proceed (the row-level filter wires up when a
   *                  per-service follow-up lands).
   *   - `exempt`   → proceed unconditionally (with an audit log line if
   *                  enforcement is `audit`).
   */
  current(): TenantContextFrame | null {
    return this.storage.getStore() ?? null;
  }

  /**
   * Runs `fn` with `frame` set as the active frame. Async work spawned
   * inside `fn` inherits the frame as long as Node's async context
   * tracking is intact (promises, awaits, `setTimeout`, etc.).
   */
  run<T>(frame: TenantContextFrame, fn: () => T): T {
    return this.storage.run(frame, fn);
  }

  /**
   * Convenience for the common "I have a `RequestContext`, give me a
   * scoped frame" path. The interceptor calls this from its
   * `ExecutionContext` lifecycle.
   */
  runWith<T>(context: RequestContext, fn: () => T): T {
    return this.run({ kind: 'scoped', context }, fn);
  }
}
