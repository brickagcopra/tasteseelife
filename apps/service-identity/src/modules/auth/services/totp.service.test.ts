import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { TotpService, _internals } from './totp.service';

/**
 * Build a minimal `Env` object for the TotpService — only the MFA
 * fields are read by the service. Cast through `unknown` because the
 * full Env shape carries fields we don't exercise here; keeping the
 * fixture narrow makes intent explicit.
 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    MFA_TOTP_PERIOD_SECONDS: 30,
    MFA_TOTP_DIGITS: 6,
    MFA_TOTP_WINDOW: 1,
    MFA_TOTP_ISSUER: 'Taste & See',
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('base32 encode/decode (RFC 4648 §6)', () => {
  // RFC 4648 §10 test vectors — base32 of ASCII strings.
  it.each([
    { plain: '', expected: '' },
    { plain: 'f', expected: 'MY' },
    { plain: 'fo', expected: 'MZXQ' },
    { plain: 'foo', expected: 'MZXW6' },
    { plain: 'foob', expected: 'MZXW6YQ' },
    { plain: 'fooba', expected: 'MZXW6YTB' },
    { plain: 'foobar', expected: 'MZXW6YTBOI' },
  ])('encodes "$plain" → "$expected"', ({ plain, expected }) => {
    expect(_internals.base32Encode(Buffer.from(plain, 'utf8'))).toBe(expected);
  });

  it('round-trips arbitrary 20-byte secrets', () => {
    for (let i = 0; i < 20; i++) {
      const original = Buffer.alloc(20);
      for (let j = 0; j < 20; j++) original[j] = (i * 17 + j * 31) & 0xff;
      const encoded = _internals.base32Encode(original);
      const decoded = _internals.base32Decode(encoded);
      expect(decoded.equals(original)).toBe(true);
    }
  });

  it('tolerates lower-case input on decode', () => {
    expect(_internals.base32Decode('mzxw6ytboi').toString('utf8')).toBe('foobar');
  });

  it('strips spaces and padding on decode', () => {
    expect(_internals.base32Decode('MZXW 6YTB OI=').toString('utf8')).toBe('foobar');
  });

  it('throws on out-of-alphabet characters', () => {
    expect(() => _internals.base32Decode('MZXW8YTBOI')).toThrow(/invalid character/);
  });
});

describe('totpCode (RFC 4226 / RFC 6238 vectors)', () => {
  /**
   * RFC 6238 Appendix B test vectors with the SHA-1 secret
   * "12345678901234567890" (the RFC 4226 ASCII secret). The vectors
   * were generated against an 8-digit code; we compare 6-digit
   * suffixes since our default is 6 digits.
   */
  const secret = Buffer.from('12345678901234567890', 'utf8');
  const period = 30;

  it.each([
    // (unix time, 8-digit RFC 6238 vector, last 6 digits)
    { time: 59, vector8: '94287082', expected6: '287082' },
    { time: 1111111109, vector8: '07081804', expected6: '081804' },
    { time: 1111111111, vector8: '14050471', expected6: '050471' },
    { time: 1234567890, vector8: '89005924', expected6: '005924' },
    { time: 2000000000, vector8: '69279037', expected6: '279037' },
  ])('matches RFC 6238 vector at t=$time', ({ time, vector8, expected6 }) => {
    const step = Math.floor(time / period);

    const code8 = _internals.totpCode({ secret, step, digits: 8 });
    expect(code8).toBe(vector8);

    const code6 = _internals.totpCode({ secret, step, digits: 6 });
    expect(code6).toBe(expected6);
  });

  it('zero-pads short codes to the requested digit length', () => {
    // Generated codes are integers mod 10^digits, so leading zeros
    // matter. Find a step that produces a sub-100k integer; if none
    // does in 100 trials, the implementation is broken in a way the
    // RFC vectors above would have caught.
    let foundShort = false;
    for (let step = 0; step < 100; step++) {
      const code = _internals.totpCode({ secret, step, digits: 6 });
      expect(code.length).toBe(6);
      if (code[0] === '0') foundShort = true;
    }
    expect(foundShort).toBe(true);
  });
});

describe('TotpService', () => {
  it('generateSecret produces a 32-character base32 string (160 bits)', () => {
    const svc = new TotpService(makeEnv());
    const secret = svc.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    // Round-trip through decoder yields exactly 20 bytes.
    expect(_internals.base32Decode(secret).length).toBe(20);
  });

  it('generateSecret produces distinct secrets across many calls (CSPRNG)', () => {
    const svc = new TotpService(makeEnv());
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(svc.generateSecret());
    expect(seen.size).toBe(50);
  });

  it('buildOtpauthUrl emits the de-facto Google-Authenticator format', () => {
    const svc = new TotpService(makeEnv());
    const url = svc.buildOtpauthUrl({
      accountLabel: 'alice@example.com',
      secretBase32: 'JBSWY3DPEHPK3PXP',
    });
    // Path: otpauth://totp/{Issuer}:{label}
    expect(url.startsWith('otpauth://totp/Taste%20%26%20See:alice%40example.com?')).toBe(true);
    // Required query params present.
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=Taste+%26+See');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });

  it('verifyCode accepts the current step', () => {
    const svc = new TotpService(makeEnv());
    const secret = svc.generateSecret();
    const now = new Date('2026-05-09T12:00:00Z');
    const expectedStep = Math.floor(now.getTime() / 1000 / 30);
    const code = svc.generateCode(secret, expectedStep);

    const matched = svc.verifyCode({ secretBase32: secret, candidate: code, now });
    expect(matched).toBe(expectedStep);
  });

  it('verifyCode accepts a code from the previous step (clock-drift tolerance)', () => {
    const svc = new TotpService(makeEnv({ MFA_TOTP_WINDOW: 1 } as Partial<Env>));
    const secret = svc.generateSecret();
    const now = new Date('2026-05-09T12:00:00Z');
    const center = Math.floor(now.getTime() / 1000 / 30);
    const previous = center - 1;
    const code = svc.generateCode(secret, previous);

    const matched = svc.verifyCode({ secretBase32: secret, candidate: code, now });
    expect(matched).toBe(previous);
  });

  it('verifyCode rejects codes outside the window', () => {
    const svc = new TotpService(makeEnv({ MFA_TOTP_WINDOW: 1 } as Partial<Env>));
    const secret = svc.generateSecret();
    const now = new Date('2026-05-09T12:00:00Z');
    const center = Math.floor(now.getTime() / 1000 / 30);
    const farPast = center - 10;
    const code = svc.generateCode(secret, farPast);

    const matched = svc.verifyCode({ secretBase32: secret, candidate: code, now });
    expect(matched).toBeNull();
  });

  it('verifyCode rejects malformed candidates without consulting the secret', () => {
    const svc = new TotpService(makeEnv());
    const secret = svc.generateSecret();
    expect(svc.verifyCode({ secretBase32: secret, candidate: '12345' })).toBeNull(); // too short
    expect(svc.verifyCode({ secretBase32: secret, candidate: '1234567' })).toBeNull(); // too long
    expect(svc.verifyCode({ secretBase32: secret, candidate: 'abcdef' })).toBeNull(); // non-digits
    expect(svc.verifyCode({ secretBase32: secret, candidate: '12 456' })).toBeNull(); // space
  });

  it('verifyCode honours lastUsedStep replay watermark', () => {
    const svc = new TotpService(makeEnv({ MFA_TOTP_WINDOW: 1 } as Partial<Env>));
    const secret = svc.generateSecret();
    const now = new Date('2026-05-09T12:00:00Z');
    const center = Math.floor(now.getTime() / 1000 / 30);
    const code = svc.generateCode(secret, center);

    // First verification with no watermark — accepted.
    expect(svc.verifyCode({ secretBase32: secret, candidate: code, now })).toBe(center);

    // Re-presented with watermark = center — rejected (replay).
    expect(
      svc.verifyCode({ secretBase32: secret, candidate: code, now, lastUsedStep: center }),
    ).toBeNull();
  });

  it('verifyCode with watermark still accepts the next-window code', () => {
    const svc = new TotpService(makeEnv({ MFA_TOTP_WINDOW: 1 } as Partial<Env>));
    const secret = svc.generateSecret();
    const now = new Date('2026-05-09T12:00:00Z');
    const center = Math.floor(now.getTime() / 1000 / 30);
    const next = center + 1;
    const code = svc.generateCode(secret, next);

    expect(
      svc.verifyCode({ secretBase32: secret, candidate: code, now, lastUsedStep: center }),
    ).toBe(next);
  });

  it('currentStep advances by one per period', () => {
    const svc = new TotpService(makeEnv());
    const t0 = new Date('2026-05-09T12:00:00Z');
    const t1 = new Date(t0.getTime() + 30_000);
    expect(svc.currentStep(t1)).toBe(svc.currentStep(t0) + 1);
  });
});
