import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { MfaSecretCipherService, MfaSecretDecryptError } from './mfa-secret-cipher.service';

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    MFA_TOTP_ENC_KEY: randomBytes(32).toString('base64'),
    MFA_TOTP_ENC_KEY_VERSION: 1,
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('MfaSecretCipherService', () => {
  it('round-trips a plaintext secret', () => {
    const cipher = new MfaSecretCipherService(makeEnv());
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.keyVersion).toBe(1);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a fresh IV per call (randomized AEAD)', () => {
    const cipher = new MfaSecretCipherService(makeEnv());
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const enc = cipher.encrypt('JBSWY3DPEHPK3PXP');
      ivs.add(enc.iv.toString('hex'));
    }
    expect(ivs.size).toBe(20);
  });

  it('rejects a row encrypted under a different key (GCM auth fail)', () => {
    const cipherA = new MfaSecretCipherService(makeEnv());
    const cipherB = new MfaSecretCipherService(makeEnv()); // different key
    const enc = cipherA.encrypt('JBSWY3DPEHPK3PXP');
    expect(() => cipherB.decrypt(enc)).toThrow(MfaSecretDecryptError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const cipher = new MfaSecretCipherService(makeEnv());
    const enc = cipher.encrypt('JBSWY3DPEHPK3PXP');
    const tampered = {
      ...enc,
      ciphertext: Buffer.from(enc.ciphertext),
    };
    tampered.ciphertext.writeUInt8(tampered.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(MfaSecretDecryptError);
  });

  it('rejects a tampered auth tag', () => {
    const cipher = new MfaSecretCipherService(makeEnv());
    const enc = cipher.encrypt('JBSWY3DPEHPK3PXP');
    const tampered = { ...enc, authTag: Buffer.from(enc.authTag) };
    tampered.authTag.writeUInt8(tampered.authTag.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(MfaSecretDecryptError);
  });

  it('rejects a tampered IV', () => {
    const cipher = new MfaSecretCipherService(makeEnv());
    const enc = cipher.encrypt('JBSWY3DPEHPK3PXP');
    const tampered = { ...enc, iv: Buffer.from(enc.iv) };
    tampered.iv.writeUInt8(tampered.iv.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(MfaSecretDecryptError);
  });

  it('rejects a row with a key version that does not match current config', () => {
    const cipher = new MfaSecretCipherService(
      makeEnv({ MFA_TOTP_ENC_KEY_VERSION: 2 } as Partial<Env>),
    );
    const enc = cipher.encrypt('JBSWY3DPEHPK3PXP');
    expect(enc.keyVersion).toBe(2);
    // Force a row that claims key version 1 — current config is 2.
    const stale = { ...enc, keyVersion: 1 };
    expect(() => cipher.decrypt(stale)).toThrow(/key version mismatch/);
  });

  it('throws on construction with a wrong-length key', () => {
    const env = { MFA_TOTP_ENC_KEY: 'AAAA', MFA_TOTP_ENC_KEY_VERSION: 1 } as unknown as Env;
    expect(() => new MfaSecretCipherService(env)).toThrow(/32 bytes/);
  });
});
