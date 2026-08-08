import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import {
  BackgroundCheckPayloadCipherService,
  BackgroundCheckPayloadDecryptError,
} from './background-check-payload-cipher.service';

/**
 * Cipher discipline mirrors KycPayloadCipherService / IntakePayloadCipherService:
 * round-trip, fresh IV per call, GCM auth fails on tampered material,
 * key-version mismatch fails closed.
 */
const KEY = randomBytes(32);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: KEY.toString('base64'),
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION: 1,
    ...overrides,
  } as unknown as Env;
}

describe('BackgroundCheckPayloadCipherService', () => {
  it('round-trips a representative Checkr-payload string', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const plaintext = JSON.stringify({
      id: 'evt_abc',
      type: 'report.completed',
      object: { id: 'rep_abc', status: 'clear' },
    });
    const encrypted = cipher.encrypt(plaintext);
    const decrypted = cipher.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
    expect(encrypted.keyVersion).toBe(1);
  });

  it('emits a fresh IV per encrypt call', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const enc = cipher.encrypt('payload');
      ivs.add(enc.iv.toString('hex'));
    }
    expect(ivs.size).toBe(20);
  });

  it('fails with BackgroundCheckPayloadDecryptError when the key changes', () => {
    const a = new BackgroundCheckPayloadCipherService(makeEnv());
    const b = new BackgroundCheckPayloadCipherService(
      makeEnv({
        BACKGROUND_CHECK_PAYLOAD_ENC_KEY: randomBytes(32).toString('base64'),
      }),
    );
    const enc = a.encrypt('payload');
    expect(() => b.decrypt(enc)).toThrow(BackgroundCheckPayloadDecryptError);
  });

  it('fails on tampered ciphertext', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const enc = cipher.encrypt('payload');
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt({ ...enc, ciphertext: tampered })).toThrow(
      BackgroundCheckPayloadDecryptError,
    );
  });

  it('fails on tampered auth tag', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const enc = cipher.encrypt('payload');
    const tampered = Buffer.from(enc.authTag);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt({ ...enc, authTag: tampered })).toThrow(
      BackgroundCheckPayloadDecryptError,
    );
  });

  it('fails on tampered IV', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const enc = cipher.encrypt('payload');
    const tampered = Buffer.from(enc.iv);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt({ ...enc, iv: tampered })).toThrow(
      BackgroundCheckPayloadDecryptError,
    );
  });

  it('fails on key-version mismatch', () => {
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const enc = cipher.encrypt('payload');
    expect(() => cipher.decrypt({ ...enc, keyVersion: 2 })).toThrow(
      BackgroundCheckPayloadDecryptError,
    );
  });

  it('throws at construction on a wrong-length key', () => {
    expect(
      () =>
        new BackgroundCheckPayloadCipherService(
          makeEnv({
            BACKGROUND_CHECK_PAYLOAD_ENC_KEY: Buffer.alloc(16, 0).toString('base64'),
          }),
        ),
    ).toThrow();
  });
});
