import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import {
  AccessInstructionsCipherService,
  AccessInstructionsDecryptError,
} from './access-instructions-cipher.service';

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    HOUSEHOLD_ACCESS_ENC_KEY: randomBytes(32).toString('base64'),
    HOUSEHOLD_ACCESS_ENC_KEY_VERSION: 1,
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('AccessInstructionsCipherService', () => {
  it('round-trips a plaintext payload', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const plaintext = JSON.stringify({
      doorCode: '4242',
      alarmCode: '8888',
      keyLocation: 'Lockbox to left of door.',
    });
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.keyVersion).toBe(1);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('round-trips multi-byte UTF-8 cleanly', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const plaintext = JSON.stringify({
      doormanInfo: '門衛 — 馬克 (Mike) 7am–3pm; doorbell on the right',
    });
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a fresh IV per call (randomized AEAD)', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const plaintext = JSON.stringify({ doorCode: '4242' });
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const enc = cipher.encrypt(plaintext);
      ivs.add(enc.iv.toString('hex'));
    }
    expect(ivs.size).toBe(20);
  });

  it('rejects a row encrypted under a different key (GCM auth fail)', () => {
    const cipherA = new AccessInstructionsCipherService(makeEnv());
    const cipherB = new AccessInstructionsCipherService(makeEnv()); // different key
    const enc = cipherA.encrypt('{"doorCode":"4242"}');
    expect(() => cipherB.decrypt(enc)).toThrow(AccessInstructionsDecryptError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const enc = cipher.encrypt('{"doorCode":"4242"}');
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext.writeUInt8(tampered.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(AccessInstructionsDecryptError);
  });

  it('rejects a tampered auth tag', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const enc = cipher.encrypt('{"doorCode":"4242"}');
    const tampered = { ...enc, authTag: Buffer.from(enc.authTag) };
    tampered.authTag.writeUInt8(tampered.authTag.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(AccessInstructionsDecryptError);
  });

  it('rejects a tampered IV', () => {
    const cipher = new AccessInstructionsCipherService(makeEnv());
    const enc = cipher.encrypt('{"doorCode":"4242"}');
    const tampered = { ...enc, iv: Buffer.from(enc.iv) };
    tampered.iv.writeUInt8(tampered.iv.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(AccessInstructionsDecryptError);
  });

  it('rejects a row whose key version does not match current config', () => {
    const cipher = new AccessInstructionsCipherService(
      makeEnv({ HOUSEHOLD_ACCESS_ENC_KEY_VERSION: 2 } as Partial<Env>),
    );
    const enc = cipher.encrypt('{"doorCode":"4242"}');
    expect(enc.keyVersion).toBe(2);
    const stale = { ...enc, keyVersion: 1 };
    expect(() => cipher.decrypt(stale)).toThrow(/key version mismatch/);
  });

  it('throws on construction with a wrong-length key', () => {
    const env = {
      HOUSEHOLD_ACCESS_ENC_KEY: 'AAAA',
      HOUSEHOLD_ACCESS_ENC_KEY_VERSION: 1,
    } as unknown as Env;
    expect(() => new AccessInstructionsCipherService(env)).toThrow(/32 bytes/);
  });
});
