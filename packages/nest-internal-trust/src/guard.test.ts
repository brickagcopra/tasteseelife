import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { TrustHeaderGuard, type RequestWithContext } from './guard';
import { TRUST_HEADERS } from './headers';
import type { ValidatedTrustHeaderOptions } from './module/options';
import { signTrustHeaders } from './signer';

const SECRET = 't'.repeat(32);
const FIXED_NOW = new Date('2026-05-16T10:00:00.000Z');

const OPTIONS: ValidatedTrustHeaderOptions = Object.freeze({
  signingSecret: SECRET,
  maxAgeSeconds: 60,
  futureToleranceSeconds: 5,
});

const SAMPLE_ACTOR: RequestContext = {
  userId: 'usr_abc',
  sessionId: 'sess_xyz',
  mfaVerified: true,
  roles: [
    {
      name: 'family_payer',
      scope: { type: 'global' },
      permissions: ['subscription:write'],
    },
  ],
  tenantScope: { type: 'global' },
};

function fakeContext(headers: Record<string, string | string[] | undefined>): {
  ctx: ExecutionContext;
  request: RequestWithContext;
} {
  const request = { headers } as unknown as RequestWithContext;
  const ctx = {
    switchToHttp: () => ({
      getRequest: <T extends Request>(): T => request as unknown as T,
    }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('TrustHeaderGuard.canActivate', () => {
  it('attaches the RequestContext + returns true on a valid envelope', () => {
    // Pin the verifier's clock to the signer's clock so the
    // freshness window check is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const headers = signTrustHeaders(SAMPLE_ACTOR, { signingSecret: SECRET, now: FIXED_NOW });
      const { ctx, request } = fakeContext({ ...headers });
      const guard = new TrustHeaderGuard(OPTIONS);
      const allowed = guard.canActivate(ctx);
      expect(allowed).toBe(true);
      expect(request.requestContext?.userId).toBe('usr_abc');
      expect(request.requestContext?.mfaVerified).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws Unauthorized when any header is missing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const headers = signTrustHeaders(SAMPLE_ACTOR, { signingSecret: SECRET, now: FIXED_NOW });
      const partial: Record<string, string | undefined> = { ...headers };
      delete partial[TRUST_HEADERS.SIGNATURE];
      const { ctx, request } = fakeContext(partial);
      const guard = new TrustHeaderGuard(OPTIONS);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
      expect(request.requestContext).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws Unauthorized on a tampered signature', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const headers = signTrustHeaders(SAMPLE_ACTOR, { signingSecret: SECRET, now: FIXED_NOW });
      const tampered: Record<string, string> = { ...headers };
      tampered[TRUST_HEADERS.USER_ID] = 'usr_attacker';
      const { ctx, request } = fakeContext(tampered);
      const guard = new TrustHeaderGuard(OPTIONS);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
      expect(request.requestContext).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws Unauthorized when the envelope is expired', () => {
    const headers = signTrustHeaders(SAMPLE_ACTOR, {
      signingSecret: SECRET,
      now: new Date('2026-05-16T10:00:00.000Z'),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T10:02:00.000Z')); // 120s later
    try {
      const { ctx } = fakeContext({ ...headers });
      const guard = new TrustHeaderGuard(OPTIONS);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a generic 401 body without leaking the failure variant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    try {
      const { ctx } = fakeContext({}); // every header missing
      const guard = new TrustHeaderGuard(OPTIONS);
      try {
        guard.canActivate(ctx);
        expect.fail('expected guard to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        const body = (err as UnauthorizedException).getResponse();
        expect(body).toEqual({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required.',
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
