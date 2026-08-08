import { describe, expect, it } from 'vitest';

import { buildCanonicalInput, decodeBase64Url, encodeBase64Url } from './canonical';

describe('buildCanonicalInput', () => {
  it('joins the fields newline-separated in the documented order', () => {
    expect(
      buildCanonicalInput({
        version: 1,
        timestamp: '1779285600',
        userId: 'usr_a',
        mfa: 'true',
        sessionId: 'sess',
        rolesEncoded: 'AAA',
        tenantScopeEncoded: 'BBB',
      }),
    ).toBe(['v1', '1779285600', 'usr_a', 'true', 'sess', 'AAA', 'BBB'].join('\n'));
  });

  it('a different version prefix produces a different canonical input', () => {
    const v1 = buildCanonicalInput({
      version: 1,
      timestamp: '0',
      userId: 'u',
      mfa: 'false',
      sessionId: '',
      rolesEncoded: '',
      tenantScopeEncoded: '',
    });
    const v2 = buildCanonicalInput({
      version: 2,
      timestamp: '0',
      userId: 'u',
      mfa: 'false',
      sessionId: '',
      rolesEncoded: '',
      tenantScopeEncoded: '',
    });
    expect(v1).not.toBe(v2);
  });

  it('empty fields stay empty (no defaulting)', () => {
    expect(
      buildCanonicalInput({
        version: 1,
        timestamp: '',
        userId: '',
        mfa: 'false',
        sessionId: '',
        rolesEncoded: '',
        tenantScopeEncoded: '',
      }),
    ).toBe('v1\n\n\nfalse\n\n\n');
  });
});

describe('encodeBase64Url / decodeBase64Url', () => {
  it('round-trips ASCII', () => {
    const encoded = encodeBase64Url('hello world');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(encoded)).toBe('hello world');
  });

  it('round-trips JSON', () => {
    const value = JSON.stringify({
      roles: [{ name: 'family_payer', permissions: ['subscription:write'] }],
    });
    expect(decodeBase64Url(encodeBase64Url(value))).toBe(value);
  });

  it('strips trailing `=` padding from the encoded output', () => {
    expect(encodeBase64Url('a')).not.toContain('=');
    expect(encodeBase64Url('ab')).not.toContain('=');
    expect(encodeBase64Url('abc')).not.toContain('=');
  });

  it('uses base64url alphabet (`-` and `_`, not `+` and `/`)', () => {
    // The input "??>" reliably produces `+` / `/` in standard
    // base64; the encoder must replace them.
    const encoded = encodeBase64Url('??>');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('empty string round-trips to empty string', () => {
    expect(encodeBase64Url('')).toBe('');
    expect(decodeBase64Url('')).toBe('');
  });

  it('returns null on non-alphabet input', () => {
    expect(decodeBase64Url('not%base64!')).toBeNull();
  });

  it('decodes payloads that need padding restoration', () => {
    // base64url for 'a' is 'YQ' (no padding) — exercises the
    // length-mod-4 padding restoration branch.
    expect(decodeBase64Url('YQ')).toBe('a');
    expect(decodeBase64Url('YWI')).toBe('ab');
    expect(decodeBase64Url('YWJj')).toBe('abc');
  });
});
