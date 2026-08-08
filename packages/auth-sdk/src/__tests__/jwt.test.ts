import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { InvalidTokenError, verifyAccessToken } from '../index';

const SECRET = 'unit-test-secret-do-not-use-in-prod';

const validPayload = {
  sub: 'user_1',
  sid: 'sess_1',
  mfa: true,
  roles: [
    {
      name: 'family_payer',
      scope: { type: 'household', householdId: 'hh_x' },
      permissions: ['booking:create', 'booking:read'],
    },
  ],
  tenantScope: { type: 'household', householdId: 'hh_x' },
};

const sign = (payload: Record<string, unknown> = validPayload, options?: jwt.SignOptions): string =>
  jwt.sign(payload, SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
    ...options,
  });

describe('verifyAccessToken — happy paths', () => {
  it('returns a RequestContext for a valid HS256 token', () => {
    const token = sign();
    const ctx = verifyAccessToken(token, { secret: SECRET });
    expect(ctx.userId).toBe('user_1');
    expect(ctx.sessionId).toBe('sess_1');
    expect(ctx.mfaVerified).toBe(true);
    expect(ctx.roles).toHaveLength(1);
    expect(ctx.roles[0]?.name).toBe('family_payer');
    expect(ctx.tenantScope).toEqual({ type: 'household', householdId: 'hh_x' });
  });

  it('defaults mfaVerified to false when the `mfa` claim is absent', () => {
    const { mfa, ...withoutMfa } = validPayload;
    void mfa;
    const token = sign(withoutMfa);
    const ctx = verifyAccessToken(token, { secret: SECRET });
    expect(ctx.mfaVerified).toBe(false);
  });

  it('maps the actorOnBehalfOf impersonation claim onto the context (TS-297)', () => {
    const token = sign({ ...validPayload, actorOnBehalfOf: 'usr_operator' });
    const ctx = verifyAccessToken(token, { secret: SECRET });
    // `userId` stays the impersonated user; the claim carries the operator.
    expect(ctx.userId).toBe('user_1');
    expect(ctx.actorOnBehalfOf).toBe('usr_operator');
  });

  it('leaves actorOnBehalfOf undefined on ordinary tokens', () => {
    const ctx = verifyAccessToken(sign(), { secret: SECRET });
    expect(ctx.actorOnBehalfOf).toBeUndefined();
  });

  it('honours the audience option when issuer + audience are claimed', () => {
    const token = sign(validPayload, { audience: 'taste-and-see-api', issuer: 'identity-svc' });
    const ctx = verifyAccessToken(token, {
      secret: SECRET,
      audience: 'taste-and-see-api',
      issuer: 'identity-svc',
    });
    expect(ctx.userId).toBe('user_1');
  });
});

describe('verifyAccessToken — failure modes (all funnel through InvalidTokenError)', () => {
  it('throws InvalidTokenError on a bad signature', () => {
    const token = sign();
    expect(() => verifyAccessToken(token, { secret: 'different-secret' })).toThrow(
      InvalidTokenError,
    );
  });

  it('throws InvalidTokenError on an expired token', () => {
    const token = sign(validPayload, { expiresIn: '-1s' });
    expect(() => verifyAccessToken(token, { secret: SECRET })).toThrow(InvalidTokenError);
  });

  it('throws InvalidTokenError on audience mismatch', () => {
    const token = sign(validPayload, { audience: 'wrong-audience' });
    expect(() =>
      verifyAccessToken(token, { secret: SECRET, audience: 'taste-and-see-api' }),
    ).toThrow(InvalidTokenError);
  });

  it('throws InvalidTokenError on a payload missing required claims (e.g. roles)', () => {
    const { roles, ...withoutRoles } = validPayload;
    void roles;
    const token = sign(withoutRoles);
    expect(() => verifyAccessToken(token, { secret: SECRET })).toThrow(InvalidTokenError);
  });

  it('throws InvalidTokenError when the token uses an algorithm not on the allow-list', () => {
    const token = sign();
    expect(() => verifyAccessToken(token, { secret: SECRET, algorithms: ['RS256'] })).toThrow(
      InvalidTokenError,
    );
  });

  it('throws InvalidTokenError for a structurally bogus token string', () => {
    expect(() => verifyAccessToken('not-a-jwt', { secret: SECRET })).toThrow(InvalidTokenError);
  });

  it('throws InvalidTokenError when payload has the wrong scope shape', () => {
    const token = sign({
      ...validPayload,
      tenantScope: { type: 'household' /* missing householdId */ },
    });
    expect(() => verifyAccessToken(token, { secret: SECRET })).toThrow(InvalidTokenError);
  });
});
