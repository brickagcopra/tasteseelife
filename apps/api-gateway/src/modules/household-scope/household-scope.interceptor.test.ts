import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HouseholdScopeInterceptor } from './household-scope.interceptor';
import type {
  HouseholdScopeResolution,
  HouseholdScopeResolver,
} from './services/household-scope.resolver';

/**
 * HouseholdScopeInterceptor tests (TS-505d2-followup-5).
 *
 * The interceptor is deliberately thin — the decision lives in the
 * resolver. What is worth pinning here is what it does with each of the
 * three outcomes, and the two cases where it must not act at all.
 */

interface RequestShape {
  requestContext?: RequestContext;
  headers: Record<string, string>;
  header(name: string): string | undefined;
}

function makeRequest(args: {
  readonly ctx?: RequestContext;
  readonly headers?: Record<string, string>;
}): RequestShape {
  const headers = args.headers ?? {};
  return {
    ...(args.ctx !== undefined ? { requestContext: args.ctx } : {}),
    headers,
    header: (name: string): string | undefined => headers[name.toLowerCase()],
  };
}

function makeContext(request: RequestShape): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeHandler(): CallHandler {
  return { handle: vi.fn(() => of('body')) } as unknown as CallHandler;
}

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'usr_1',
    sessionId: 'sid_1',
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
    ...overrides,
  } as RequestContext;
}

function build(resolution: HouseholdScopeResolution): {
  interceptor: HouseholdScopeInterceptor;
  resolve: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn().mockResolvedValue(resolution);
  return {
    interceptor: new HouseholdScopeInterceptor({
      resolve,
    } as unknown as HouseholdScopeResolver),
    resolve,
  };
}

describe('HouseholdScopeInterceptor', () => {
  let handler: CallHandler;

  beforeEach(() => {
    handler = makeHandler();
  });

  it('narrows a global context to the resolved household', async () => {
    const { interceptor } = build({
      kind: 'scoped',
      scope: { type: 'household', householdId: 'hh_a' },
    });
    const request = makeRequest({ ctx: makeCtx() });
    await interceptor.intercept(makeContext(request), handler);
    expect(request.requestContext?.tenantScope).toEqual({
      type: 'household',
      householdId: 'hh_a',
    });
  });

  it('preserves every other field of the context', async () => {
    // The object it replaces is the one signed into the trust envelope —
    // dropping `roles` here would silently de-privilege every request.
    const { interceptor } = build({
      kind: 'scoped',
      scope: { type: 'household', householdId: 'hh_a' },
    });
    const ctx = makeCtx({
      roles: [{ name: 'family_payer', scope: { type: 'global' }, permissions: [] }],
      mfaVerified: true,
    });
    const request = makeRequest({ ctx });
    await interceptor.intercept(makeContext(request), handler);
    expect(request.requestContext).toEqual({
      ...ctx,
      tenantScope: { type: 'household', householdId: 'hh_a' },
    });
  });

  it('reads the household from the `x-household-id` header', async () => {
    const { interceptor, resolve } = build({ kind: 'unscoped', reason: 'no_memberships' });
    const request = makeRequest({
      ctx: makeCtx(),
      headers: { 'x-household-id': 'hh_b', 'x-trace-id': 'trace-9' },
    });
    await interceptor.intercept(makeContext(request), handler);
    expect(resolve).toHaveBeenCalledWith({
      userId: 'usr_1',
      requestedHouseholdId: 'hh_b',
      traceId: 'trace-9',
    });
  });

  it('refuses with 403 when the client names a household it does not belong to', async () => {
    const { interceptor } = build({ kind: 'forbidden' });
    const request = makeRequest({ ctx: makeCtx(), headers: { 'x-household-id': 'hh_theirs' } });
    await expect(interceptor.intercept(makeContext(request), handler)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('leaves the context global and proceeds when unscoped', async () => {
    const { interceptor } = build({ kind: 'unscoped', reason: 'ambiguous' });
    const request = makeRequest({ ctx: makeCtx() });
    await interceptor.intercept(makeContext(request), handler);
    expect(request.requestContext?.tenantScope).toEqual({ type: 'global' });
    expect(handler.handle).toHaveBeenCalledOnce();
  });

  describe('cases it must not act on', () => {
    it('ignores an unauthenticated request', async () => {
      const { interceptor, resolve } = build({ kind: 'unscoped', reason: 'no_memberships' });
      const request = makeRequest({});
      await interceptor.intercept(makeContext(request), handler);
      expect(resolve).not.toHaveBeenCalled();
      expect(request.requestContext).toBeUndefined();
      expect(handler.handle).toHaveBeenCalledOnce();
    });

    it('never overwrites an already-narrowed scope', async () => {
      // Nothing sets a `tenant` scope today, but when the partner portal
      // does (TS-400), overwriting would silently demote a partner request
      // to a household one. Narrowing only.
      const { interceptor, resolve } = build({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_a' },
      });
      const ctx = makeCtx({ tenantScope: { type: 'tenant', tenantId: 'tn_1' } });
      const request = makeRequest({ ctx });
      await interceptor.intercept(makeContext(request), handler);
      expect(resolve).not.toHaveBeenCalled();
      expect(request.requestContext?.tenantScope).toEqual({ type: 'tenant', tenantId: 'tn_1' });
    });

    it('ignores non-http execution contexts', async () => {
      const { interceptor, resolve } = build({ kind: 'unscoped', reason: 'no_memberships' });
      const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
      await interceptor.intercept(context, handler);
      expect(resolve).not.toHaveBeenCalled();
      expect(handler.handle).toHaveBeenCalledOnce();
    });
  });
});
