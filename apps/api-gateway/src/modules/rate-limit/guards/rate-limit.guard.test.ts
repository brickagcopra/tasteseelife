import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import {
  RateLimitService,
  type RateLimitDecision,
  type RateLimitPolicy,
} from '../services/rate-limit.service';
import { RATE_LIMIT_METADATA } from '../decorators/rate-limit.decorator';
import { actorKindFromKey, RateLimitMetrics } from '../services/rate-limit-metrics';
import { RateLimitGuard, resolveActorKey } from './rate-limit.guard';

interface FakeResponse {
  readonly headers: Map<string, string>;
  setHeader(name: string, value: string): void;
}

function buildResponse(): FakeResponse {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
  };
}

class StubControllerClass {}

function buildContext(
  request: Partial<RequestWithContext> & { url?: string },
  response: FakeResponse,
  metadata?: { policy: RateLimitPolicy },
): { context: ExecutionContext; reflector: Reflector } {
  const reflector = new Reflector();
  const handler = (): void => undefined;
  if (metadata !== undefined) {
    Reflect.defineMetadata(RATE_LIMIT_METADATA, metadata, handler);
  }

  const context = {
    switchToHttp: () => ({
      getRequest: <T>(): T => request as T,
      getResponse: <T>(): T => response as T,
      getNext: <T>(): T => undefined as T,
    }),
    getHandler: () => handler,
    getClass: () => StubControllerClass,
    // The remaining ExecutionContext members aren't consulted by the guard.
    getArgs: () => [] as never,
    getArgByIndex: () => undefined as never,
    getType: () => 'http' as never,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext;
  return { context, reflector };
}

class StubRateLimitService {
  public lastCall: { policy: RateLimitPolicy; actorKey: string } | null = null;
  constructor(private readonly decision: RateLimitDecision) {}
  async consume(policy: RateLimitPolicy, actorKey: string): Promise<RateLimitDecision> {
    this.lastCall = { policy, actorKey };
    return this.decision;
  }
}

describe('resolveActorKey', () => {
  it('prefers the authenticated user id when present', () => {
    const request = {
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
      headers: {},
    } as unknown as RequestWithContext;
    expect(resolveActorKey(request)).toBe('user:usr_abc');
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.1' },
    } as unknown as RequestWithContext;
    expect(resolveActorKey(request)).toBe('ip:203.0.113.7');
  });

  it('falls back to req.ip when no XFF header is present', () => {
    const request = {
      headers: {},
      ip: '10.0.0.1',
    } as unknown as RequestWithContext;
    expect(resolveActorKey(request)).toBe('ip:10.0.0.1');
  });

  it('falls back to ip:unknown when neither user nor headers identify the client', () => {
    const request = { headers: {} } as unknown as RequestWithContext;
    expect(resolveActorKey(request)).toBe('ip:unknown');
  });
});

/**
 * Build the guard with the REAL metrics class (TS-140-followup-4). Its
 * instruments come from `getMeter`, a no-op with no SDK booted, so
 * constructing it is free; the spy is what lets the suite assert the outcome
 * label — and the fail-open case in particular, which is invisible in every
 * other signal because the request succeeds.
 */
function buildGuard(
  reflector: Reflector,
  stub: StubRateLimitService,
): { guard: RateLimitGuard; recordDecision: ReturnType<typeof vi.spyOn> } {
  const metrics = new RateLimitMetrics();
  const recordDecision = vi.spyOn(metrics, 'recordDecision');
  return {
    guard: new RateLimitGuard(reflector, stub as unknown as RateLimitService, metrics),
    recordDecision,
  };
}

describe('RateLimitGuard.canActivate', () => {
  let response: FakeResponse;
  beforeEach(() => {
    response = buildResponse();
  });

  it('passes through and sets RateLimit headers on an allowed decision', async () => {
    const stub = new StubRateLimitService({
      allowed: true,
      remaining: 5,
      limit: 10,
      retryAfterSeconds: 0,
      windowSeconds: 60,
      unavailable: false,
    });
    const request = {
      headers: {},
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
    } as unknown as RequestWithContext;
    const { context, reflector } = buildContext(request, response);
    const { guard, recordDecision } = buildGuard(reflector, stub);

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(response.headers.get('x-ratelimit-limit')).toBe('10');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('5');
    expect(response.headers.get('x-ratelimit-window-seconds')).toBe('60');
    expect(stub.lastCall?.actorKey).toBe('user:usr_abc');
    expect(stub.lastCall?.policy).toBe('default');
    // The allowed majority is counted too — a decisions counter that only
    // moves on rejections cannot express a rejection RATE.
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision).toHaveBeenCalledWith('default', 'allowed', 'user');
  });

  it('honours the @RateLimit({policy: "sensitive"}) decorator', async () => {
    const stub = new StubRateLimitService({
      allowed: true,
      remaining: 1,
      limit: 2,
      retryAfterSeconds: 0,
      windowSeconds: 300,
      unavailable: false,
    });
    const request = {
      headers: {},
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
    } as unknown as RequestWithContext;
    const { context, reflector } = buildContext(request, response, { policy: 'sensitive' });
    const { guard, recordDecision } = buildGuard(reflector, stub);

    await guard.canActivate(context);
    expect(stub.lastCall?.policy).toBe('sensitive');
    // `sensitive` firing and `default` firing are different events; the HTTP
    // 429 series cannot tell them apart.
    expect(recordDecision).toHaveBeenCalledWith('sensitive', 'allowed', 'user');
  });

  it('throws 429 with Retry-After when the decision rejects', async () => {
    const stub = new StubRateLimitService({
      allowed: false,
      remaining: 0,
      limit: 10,
      retryAfterSeconds: 17,
      windowSeconds: 60,
      unavailable: false,
    });
    const request = {
      headers: {},
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
    } as unknown as RequestWithContext;
    const { context, reflector } = buildContext(request, response);
    const { guard, recordDecision } = buildGuard(reflector, stub);

    let caught: HttpException | null = null;
    try {
      await guard.canActivate(context);
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.getStatus()).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    const body = caught!.getResponse() as { detail?: string; retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBe(17);
    // Recorded BEFORE the throw — a blocked request must not be the one
    // outcome that goes uncounted.
    expect(recordDecision).toHaveBeenCalledWith('default', 'blocked', 'user');
  });

  it('passes through with X-RateLimit-Status=unavailable when Redis fails open', async () => {
    const stub = new StubRateLimitService({
      allowed: true,
      remaining: 10,
      limit: 10,
      retryAfterSeconds: 0,
      windowSeconds: 60,
      unavailable: true,
    });
    const request = {
      headers: {},
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
    } as unknown as RequestWithContext;
    const { context, reflector } = buildContext(request, response);
    const { guard, recordDecision } = buildGuard(reflector, stub);

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(response.headers.get('x-ratelimit-status')).toBe('unavailable');
    // THE case this metric exists for. The service returns `allowed: true`,
    // the request succeeds, and the HTTP status is a perfectly ordinary 200 —
    // so without this label nothing anywhere says the gateway is currently
    // running unlimited. `allowed` here would be a lie of exactly the kind
    // that gets discovered after an incident.
    expect(recordDecision).toHaveBeenCalledWith('default', 'unavailable', 'user');
  });
});

describe('actorKindFromKey', () => {
  it('classifies an authenticated key as `user`', () => {
    expect(actorKindFromKey('user:usr_abc')).toBe('user');
  });

  it('classifies an address key as `ip`', () => {
    expect(actorKindFromKey('ip:203.0.113.7')).toBe('ip');
  });

  it('classifies the no-identity bucket as `unknown`, NOT as `ip`', () => {
    // `ip:unknown` is the shared bucket every header-less caller falls into.
    // Reporting it as `ip` would make one bucket look like one client, which
    // is the reading that turns a crawler into a "user under attack".
    expect(actorKindFromKey('ip:unknown')).toBe('unknown');
  });

  it('never returns the key itself for an unrecognised shape', () => {
    // The key carries a user id or an address; neither may reach a label
    // (CLAUDE.md §10 / §17.2). An unparseable key degrades to `unknown`
    // rather than being passed through.
    expect(actorKindFromKey('something-else')).toBe('unknown');
  });
});
