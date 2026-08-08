import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { KycPayloadCipherService, KycPayloadDecryptError } from './kyc-payload-cipher.service';

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    KYC_PAYLOAD_ENC_KEY: randomBytes(32).toString('base64'),
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('KycPayloadCipherService', () => {
  // A representative Stripe Identity payload — JSON-stringified for the
  // round-trip. The realistic payload is ~1-2 KiB; the test uses a
  // smaller stub but exercises the same encrypt/decrypt path.
  const PAYLOAD = JSON.stringify({
    id: 'vs_1NXY2Z',
    object: 'identity.verification_session',
    status: 'verified',
    type: 'document',
    verified_outputs: {
      first_name: 'Alice',
      last_name: 'Wonderland',
    },
  });

  it('round-trips a JSON payload', () => {
    const cipher = new KycPayloadCipherService(makeEnv());
    const enc = cipher.encrypt(PAYLOAD);
    expect(enc.iv.length).toBe(12);
    expect(enc.authTag.length).toBe(16);
    expect(enc.keyVersion).toBe(1);
    expect(cipher.decrypt(enc)).toBe(PAYLOAD);
  });

  it('produces a fresh IV per call (randomized AEAD)', () => {
    const cipher = new KycPayloadCipherService(makeEnv());
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const enc = cipher.encrypt(PAYLOAD);
      ivs.add(enc.iv.toString('hex'));
    }
    expect(ivs.size).toBe(20);
  });

  it('rejects a row encrypted under a different key (GCM auth fail)', () => {
    const cipherA = new KycPayloadCipherService(makeEnv());
    const cipherB = new KycPayloadCipherService(makeEnv()); // different random key
    const enc = cipherA.encrypt(PAYLOAD);
    expect(() => cipherB.decrypt(enc)).toThrow(KycPayloadDecryptError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const cipher = new KycPayloadCipherService(makeEnv());
    const enc = cipher.encrypt(PAYLOAD);
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext.writeUInt8(tampered.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(KycPayloadDecryptError);
  });

  it('rejects a tampered auth tag', () => {
    const cipher = new KycPayloadCipherService(makeEnv());
    const enc = cipher.encrypt(PAYLOAD);
    const tampered = { ...enc, authTag: Buffer.from(enc.authTag) };
    tampered.authTag.writeUInt8(tampered.authTag.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(KycPayloadDecryptError);
  });

  it('rejects a tampered IV', () => {
    const cipher = new KycPayloadCipherService(makeEnv());
    const enc = cipher.encrypt(PAYLOAD);
    const tampered = { ...enc, iv: Buffer.from(enc.iv) };
    tampered.iv.writeUInt8(tampered.iv.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(KycPayloadDecryptError);
  });

  it('rejects a row with a key version that does not match current config', () => {
    const cipher = new KycPayloadCipherService(
      makeEnv({ KYC_PAYLOAD_ENC_KEY_VERSION: 2 } as Partial<Env>),
    );
    const enc = cipher.encrypt(PAYLOAD);
    expect(enc.keyVersion).toBe(2);
    // Force a row that claims key version 1 — current config is 2.
    const stale = { ...enc, keyVersion: 1 };
    expect(() => cipher.decrypt(stale)).toThrow(/key version mismatch/);
  });

  it('throws on construction with a wrong-length key', () => {
    const env = {
      KYC_PAYLOAD_ENC_KEY: 'AAAA',
      KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    } as unknown as Env;
    expect(() => new KycPayloadCipherService(env)).toThrow(/32 bytes/);
  });
});
