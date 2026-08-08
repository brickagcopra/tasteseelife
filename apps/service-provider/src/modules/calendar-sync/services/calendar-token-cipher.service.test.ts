import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import {
  CalendarTokenCipherNotConfiguredError,
  CalendarTokenCipherService,
  CalendarTokenDecryptError,
} from './calendar-token-cipher.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    CALENDAR_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    CALENDAR_TOKEN_ENC_KEY_VERSION: 1,
    ...overrides,
  } as Env;
}

describe('CalendarTokenCipherService', () => {
  it('round-trips a refresh token', () => {
    const cipher = new CalendarTokenCipherService(buildEnv());
    const row = cipher.encrypt('1//refresh-token-value');
    expect(cipher.decrypt(row)).toBe('1//refresh-token-value');
    expect(row.keyVersion).toBe(1);
    // The ciphertext must not contain the plaintext.
    expect(row.ciphertext.toString('utf8')).not.toContain('refresh-token-value');
  });

  it('produces a distinct IV per call (no IV reuse)', () => {
    const cipher = new CalendarTokenCipherService(buildEnv());
    const a = cipher.encrypt('token');
    const b = cipher.encrypt('token');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('fails closed on a tampered auth tag (GCM authentication failure)', () => {
    const cipher = new CalendarTokenCipherService(buildEnv());
    const row = cipher.encrypt('token');
    const tampered = { ...row, authTag: Buffer.alloc(row.authTag.length, 0) };
    expect(() => cipher.decrypt(tampered)).toThrow(CalendarTokenDecryptError);
  });

  it('fails closed on a key-version mismatch', () => {
    const cipher = new CalendarTokenCipherService(buildEnv());
    const row = cipher.encrypt('token');
    expect(() => cipher.decrypt({ ...row, keyVersion: 2 })).toThrow(CalendarTokenDecryptError);
  });

  it('reports unconfigured when the key is unset + throws on use', () => {
    const cipher = new CalendarTokenCipherService(buildEnv({ CALENDAR_TOKEN_ENC_KEY: undefined }));
    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt('token')).toThrow(CalendarTokenCipherNotConfiguredError);
  });

  it('throws at construction on a wrong-length key (defence in depth)', () => {
    expect(
      () =>
        new CalendarTokenCipherService(
          buildEnv({ CALENDAR_TOKEN_ENC_KEY: Buffer.alloc(16, 1).toString('base64') }),
        ),
    ).toThrow(/32 bytes/);
  });
});
