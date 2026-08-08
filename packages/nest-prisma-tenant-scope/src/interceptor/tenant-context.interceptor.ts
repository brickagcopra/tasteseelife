import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import { Observable } from 'rxjs';

import type { ValidatedOptions } from '../config';
import { TenantContextStore } from '../context/context-store';
import { TENANT_CONTEXT_OPTIONS_TOKEN, TENANT_CONTEXT_STORE_TOKEN } from '../module/tokens';

/**
 * Reads `request.requestContext` (populated by `AccessTokenGuard`) and
 * seeds the `TenantContextStore` for the lifetime of the request.
 *
 * Why an Observable wrapper instead of `await next.handle().toPromise()`:
 * an interceptor that returns a plain Observable lets Nest's RxJS
 * pipeline retain backpressure semantics + finalizer hooks. The
 * `AsyncLocalStorage.run` callback must enclose the subscription, NOT
 * just the call to `next.handle()`; otherwise the frame leaks out as
 * soon as the synchronous chain unwinds and async work inside the
 * handler executes with `current() === null`.
 *
 * Behaviour when the request does NOT have a `requestContext`:
 *
 *   - The interceptor passes through (no frame is set). This is normal
 *     for the pre-auth surface (POST /auth/signup, POST /auth/login,
 *     POST /auth/refresh) where the guard hasn't run yet. The
 *     extension's `audit` / `enforce` modes decide what happens
 *     downstream when a query tries to run unscoped.
 *
 *   - It does NOT auto-emit an `exempt` frame for unauthenticated
 *     surfaces. An explicit `runWithoutTenantContext('public-surface', ...)`
 *     wrapper is the right primitive there — the implicit pass-through
 *     would let an authenticated-but-untagged request slip past
 *     enforcement silently.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly store: TenantContextStore,
    @Inject(TENANT_CONTEXT_OPTIONS_TOKEN) private readonly options: ValidatedOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<unknown>();
    // Pass the full request through to the resolver — custom resolvers
    // may pick up the context from a different slot (e.g. `request.auth.context`
    // in services that don't use the canonical Express augmentation). The
    // default resolver in `config.ts` reads `request.requestContext`.
    const resolved = this.options.actorResolver(request as { requestContext?: unknown });

    if (!isRequestContext(resolved)) {
      // No authenticated context on the request — pass through. The
      // extension will gate based on enforcement mode if a query lands
      // without a frame.
      return next.handle();
    }

    const ctx = resolved;

    // Wrap the entire Observable lifecycle inside AsyncLocalStorage.run
    // so async work in the downstream pipeline sees the frame.
    return new Observable((subscriber) => {
      let sub: { unsubscribe: () => void } | null = null;
      this.store.runWith(ctx, () => {
        sub = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
      return () => {
        sub?.unsubscribe();
      };
    });
  }
}

/**
 * Structural type guard for `RequestContext`. We don't import a zod
 * schema here because the auth-sdk's contract is already validated at
 * the JWT-verification boundary; a second parse on every request would
 * be wasteful. The guard only confirms the shape is roughly what the
 * extension consumes — the source of truth lives in `auth-sdk`.
 */
function isRequestContext(value: unknown): value is RequestContext {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.userId === 'string' &&
    typeof obj.mfaVerified === 'boolean' &&
    Array.isArray(obj.roles) &&
    typeof obj.tenantScope === 'object' &&
    obj.tenantScope !== null
  );
}
