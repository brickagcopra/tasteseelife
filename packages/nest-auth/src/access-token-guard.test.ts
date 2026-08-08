import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  TRUST_HEADERS,
  signTrustHeaders,
  validateTrustHeaderOptions,
} from '@taste-and-see/nest-internal-trust';

import { AccessTokenGuard, type RequestWithContext } from './access-token-guard';
import { type ValidatedNestAuthOptions } from './module/options';

function makeOptions(overrides: Partial<ValidatedNestAuthOptions> = {}): ValidatedNestAuthOptions {
  return Object.freeze({
    jwtAccessSecret: 'a'.repeat(32),
    jwtIssuer: 'taste-and-see/service-identity',
    jwtAudience: 'taste-and-see/api',
    // Bearer-only by default: that is what an un-migrated service gets,
    // and it keeps every pre-existing assertion below about the same
    // guard the platform ran before TS-140-followup-1a.
    internalTrust: null,
    ...overrides,
  });
}

const TRUST_SECRET = 't'.repeat(32);

function makeTrustOptions(): ValidatedNestAuthOptions {
  return makeOptions({
    internalTrust: validateTrustHeaderOptions({
      signingSecret: TRUST_SECRET,
      maxAgeSeconds: 60,
    }),
  });
}

const ACTOR: RequestContext = {
  userId: 'usr_gateway',
  sessionId: 'sid_gateway',
  mfaVerified: true,
  roles: [],
  tenantScope: { type: 'global' },
};

function makeContext(request: Partial<RequestWithContext>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function signValidToken(
  options: ValidatedNestAuthOptions,
  payload: Record<string, unknown> = {},
): string {
  return jwt.sign(
    {
      sub: 'usr_1',
      sid: 'sid_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
      ...payload,
    },
    options.jwtAccessSecret,
    {
      algorithm: 'HS256',
      expiresIn: 900,
      issuer: options.jwtIssuer,
      audience: options.jwtAudience,
    },
  );
}

describe('AccessTokenGuard', () => {
  it('attaches requestContext on a valid Bearer token', async () => {
    const options = makeOptions();
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${signValidToken(options)}` },
    };
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.requestContext?.userId).toBe('usr_1');
  });

  it('rejects when the Authorization header is missing', async () => {
    const guard = new AccessTokenGuard(makeOptions());
    const request: Partial<RequestWithContext> = { headers: {} };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer scheme', async () => {
    const guard = new AccessTokenGuard(makeOptions());
    const request: Partial<RequestWithContext> = { headers: { authorization: 'Basic xyz' } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an empty Bearer value', async () => {
    const guard = new AccessTokenGuard(makeOptions());
    const request: Partial<RequestWithContext> = { headers: { authorization: 'Bearer ' } };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong secret (no cross-service forgery)', async () => {
    const options = makeOptions();
    const forged = jwt.sign(
      { sub: 'x', roles: [], tenantScope: { type: 'global' } },
      'b'.repeat(32),
      {
        algorithm: 'HS256',
        issuer: options.jwtIssuer,
        audience: options.jwtAudience,
        expiresIn: 60,
      },
    );
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${forged}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const options = makeOptions();
    const expired = jwt.sign(
      { sub: 'usr_1', roles: [], tenantScope: { type: 'global' } },
      options.jwtAccessSecret,
      {
        algorithm: 'HS256',
        issuer: options.jwtIssuer,
        audience: options.jwtAudience,
        expiresIn: -1,
      },
    );
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${expired}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token from the wrong issuer', async () => {
    const options = makeOptions();
    const wrongIssuer = jwt.sign(
      { sub: 'usr_1', roles: [], tenantScope: { type: 'global' } },
      options.jwtAccessSecret,
      {
        algorithm: 'HS256',
        issuer: 'someone-else',
        audience: options.jwtAudience,
        expiresIn: 60,
      },
    );
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${wrongIssuer}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token whose audience does not match', async () => {
    const options = makeOptions();
    const wrongAud = jwt.sign(
      { sub: 'usr_1', roles: [], tenantScope: { type: 'global' } },
      options.jwtAccessSecret,
      {
        algorithm: 'HS256',
        issuer: options.jwtIssuer,
        audience: 'someone-else',
        expiresIn: 60,
      },
    );
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${wrongAud}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong algorithm (HS512 swap rejected)', async () => {
    const options = makeOptions();
    const hs512 = jwt.sign(
      { sub: 'usr_1', roles: [], tenantScope: { type: 'global' } },
      options.jwtAccessSecret,
      {
        algorithm: 'HS512',
        issuer: options.jwtIssuer,
        audience: options.jwtAudience,
        expiresIn: 60,
      },
    );
    const guard = new AccessTokenGuard(options);
    const request: Partial<RequestWithContext> = {
      headers: { authorization: `Bearer ${hs512}` },
    };
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  /**
   * The gateway trust envelope (TS-140-followup-1a).
   *
   * These assertions exist because the platform's entire authenticated
   * surface depends on this path: the api-gateway never forwards the
   * caller's bearer token downstream, so before this path existed every
   * proxied route on every service answered 401.
   */
  describe('gateway trust envelope', () => {
    it('accepts a gateway-signed envelope with no bearer token at all', async () => {
      const options = makeTrustOptions();
      const guard = new AccessTokenGuard(options);
      const request: Partial<RequestWithContext> = {
        headers: { ...signTrustHeaders(ACTOR, { signingSecret: TRUST_SECRET }) },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      // The recovered actor is the gateway's, not a decoded token's —
      // this is what every downstream row-level check reads.
      expect(request.requestContext?.userId).toBe(ACTOR.userId);
      expect(request.requestContext?.mfaVerified).toBe(true);
    });

    it('rejects an envelope signed with a different secret', async () => {
      const guard = new AccessTokenGuard(makeTrustOptions());
      const request: Partial<RequestWithContext> = {
        headers: { ...signTrustHeaders(ACTOR, { signingSecret: 'x'.repeat(32) }) },
      };

      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('does NOT fall back to a valid bearer when the envelope fails to verify', async () => {
      const options = makeTrustOptions();
      const guard = new AccessTokenGuard(options);
      const request: Partial<RequestWithContext> = {
        headers: {
          ...signTrustHeaders(ACTOR, { signingSecret: 'x'.repeat(32) }),
          authorization: `Bearer ${signValidToken(options)}`,
        },
      };

      // The property that makes a rotated signing secret visible instead
      // of silently degrading: a request that CLAIMS to come from the
      // gateway is judged as such, and a bad envelope is never quietly
      // rescued by a token the gateway would not have forwarded anyway.
      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('still accepts a bearer token from a direct caller carrying no envelope', async () => {
      const options = makeTrustOptions();
      const guard = new AccessTokenGuard(options);
      const request: Partial<RequestWithContext> = {
        headers: { authorization: `Bearer ${signValidToken(options)}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.requestContext?.userId).toBe('usr_1');
    });

    it('ignores an envelope entirely on a service that was not wired for trust', async () => {
      // An un-migrated service must behave exactly as it did before, so
      // the rollout stays per-service and revertable. Here the envelope
      // is well-formed and correctly signed and is STILL not honoured —
      // the absence of `internalTrust` is the whole gate.
      const guard = new AccessTokenGuard(makeOptions());
      const request: Partial<RequestWithContext> = {
        headers: { ...signTrustHeaders(ACTOR, { signingSecret: TRUST_SECRET }) },
      };

      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('treats a lone signature header as a claim to be verified, not as absence', async () => {
      // Presence is keyed on the signature alone. Stripping the other
      // headers must not downgrade the request onto the bearer path —
      // otherwise removing one header from a tampered envelope would be
      // a way to be judged more leniently.
      const options = makeTrustOptions();
      const guard = new AccessTokenGuard(options);
      const request: Partial<RequestWithContext> = {
        headers: {
          [TRUST_HEADERS.SIGNATURE]: 'not-a-signature',
          authorization: `Bearer ${signValidToken(options)}`,
        },
      };

      await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
