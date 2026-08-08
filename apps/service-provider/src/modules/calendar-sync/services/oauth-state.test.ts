import { describe, expect, it } from 'vitest';

import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from './oauth-state';

const SECRET = 's'.repeat(48);

function payload(overrides: Partial<OAuthStatePayload> = {}): OAuthStatePayload {
  return {
    providerId: 'prov_1',
    actorUserId: 'user_1',
    nonce: 'abc123',
    exp: 2_000_000_000,
    ...overrides,
  };
}

describe('signOAuthState / verifyOAuthState', () => {
  it('round-trips a payload', () => {
    const token = signOAuthState(SECRET, payload());
    const result = verifyOAuthState(SECRET, token, 1_000_000_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.providerId).toBe('prov_1');
      expect(result.payload.actorUserId).toBe('user_1');
      expect(result.payload.nonce).toBe('abc123');
    }
  });

  it('rejects a tampered payload segment (bad signature)', () => {
    const token = signOAuthState(SECRET, payload());
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify(payload({ providerId: 'prov_evil' })),
      'utf8',
    ).toString('base64url');
    const forged = `${forgedPayload}.${sig}`;
    const result = verifyOAuthState(SECRET, forged, 1_000_000_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signOAuthState('other-secret-other-secret-other!', payload());
    const result = verifyOAuthState(SECRET, token, 1_000_000_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const token = signOAuthState(SECRET, payload({ exp: 1_000 }));
    const result = verifyOAuthState(SECRET, token, 2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('treats exp == now as expired (strictly future)', () => {
    const token = signOAuthState(SECRET, payload({ exp: 5_000 }));
    const result = verifyOAuthState(SECRET, token, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it.each(['', 'no-dot', 'a.b.c', '.b', 'a.'])('rejects a malformed token shape: %j', (token) => {
    const result = verifyOAuthState(SECRET, token, 1_000);
    expect(result.ok).toBe(false);
  });
});
