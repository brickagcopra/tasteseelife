import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import {
  IntakePayloadCipherService,
  IntakePayloadDecryptError,
} from './intake-payload-cipher.service';

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    HOUSEHOLD_INTAKE_ENC_KEY: randomBytes(32).toString('base64'),
    HOUSEHOLD_INTAKE_ENC_KEY_VERSION: 1,
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('IntakePayloadCipherService', () => {
  it('round-trips a plaintext payload', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const plaintext = JSON.stringify({
      dateOfBirth: '1942-03-14',
      medicalNotes: 'Type 2 diabetes, well controlled.',
    });
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.keyVersion).toBe(1);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('round-trips multi-byte UTF-8 cleanly', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const plaintext = JSON.stringify({
      dietaryNotes: '愛 — kosher, no shellfish; jollof rice on holidays.',
    });
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a fresh IV per call (randomized AEAD)', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const plaintext = JSON.stringify({ dateOfBirth: '1942-03-14' });
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const enc = cipher.encrypt(plaintext);
      ivs.add(enc.iv.toString('hex'));
    }
    expect(ivs.size).toBe(20);
  });

  it('rejects a row encrypted under a different key (GCM auth fail)', () => {
    const cipherA = new IntakePayloadCipherService(makeEnv());
    const cipherB = new IntakePayloadCipherService(makeEnv()); // different key
    const enc = cipherA.encrypt('{"dateOfBirth":"1942-03-14"}');
    expect(() => cipherB.decrypt(enc)).toThrow(IntakePayloadDecryptError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const enc = cipher.encrypt('{"dateOfBirth":"1942-03-14"}');
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext.writeUInt8(tampered.ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(IntakePayloadDecryptError);
  });

  it('rejects a tampered auth tag', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const enc = cipher.encrypt('{"dateOfBirth":"1942-03-14"}');
    const tampered = { ...enc, authTag: Buffer.from(enc.authTag) };
    tampered.authTag.writeUInt8(tampered.authTag.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(IntakePayloadDecryptError);
  });

  it('rejects a tampered IV', () => {
    const cipher = new IntakePayloadCipherService(makeEnv());
    const enc = cipher.encrypt('{"dateOfBirth":"1942-03-14"}');
    const tampered = { ...enc, iv: Buffer.from(enc.iv) };
    tampered.iv.writeUInt8(tampered.iv.readUInt8(0) ^ 0xff, 0);
    expect(() => cipher.decrypt(tampered)).toThrow(IntakePayloadDecryptError);
  });

  it('rejects a row whose key version does not match current config', () => {
    const cipher = new IntakePayloadCipherService(
      makeEnv({ HOUSEHOLD_INTAKE_ENC_KEY_VERSION: 2 } as Partial<Env>),
    );
    const enc = cipher.encrypt('{"dateOfBirth":"1942-03-14"}');
    expect(enc.keyVersion).toBe(2);
    const stale = { ...enc, keyVersion: 1 };
    expect(() => cipher.decrypt(stale)).toThrow(/key version mismatch/);
  });

  it('throws on construction with a wrong-length key', () => {
    const env = {
      HOUSEHOLD_INTAKE_ENC_KEY: 'AAAA',
      HOUSEHOLD_INTAKE_ENC_KEY_VERSION: 1,
    } as unknown as Env;
    expect(() => new IntakePayloadCipherService(env)).toThrow(/32 bytes/);
  });
});
