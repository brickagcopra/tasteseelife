import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Envelope-encryption helper for the at-rest Google refresh token
 * (`provider.provider_calendar_connections.refresh_token_*`) — TS-206.
 *
 * Algorithm. AES-256-GCM, the modern default for symmetric AEAD.
 *   - 256-bit key (NIST SP 800-38D / FIPS 197).
 *   - 96-bit IV per call (NIST SP 800-38D §8.2).
 *   - 128-bit auth tag (GCM default, maximum safe forgery margin).
 *
 * Same shape as `BackgroundCheckPayloadCipherService` (TS-051),
 * `KycPayloadCipherService` (TS-026), and `IntakePayloadCipherService`
 * (TS-031). The key is **independent**: a leaked calendar cipher key
 * does not grant the ability to read background-check / KYC / intake
 * payloads, and vice versa (CLAUDE.md §3.5 compartmentalisation).
 *
 * Random IV, not a counter. IV reuse under the same key catastrophically
 * breaks GCM. Random 96-bit IVs have a birthday-bound collision
 * probability of ~2^-32 at 2^32 encryptions — well past the realistic
 * per-key encrypt count (one write per provider connect / re-consent,
 * lifetime measured in years).
 *
 * Key versioning. The row stores `refresh_token_key_version`, an integer
 * pointing at which key encrypted the row. Phase 1 ships version 1; a
 * future rotation increments `CALENDAR_TOKEN_ENC_KEY_VERSION`, encrypts
 * new rows under the new version, and a backfill worker
 * (TS-206-followup-5) re-wraps legacy rows. `decrypt` rejects rows whose
 * `keyVersion` does not match — the fail-closed rotation contract.
 *
 * **Unconfigured posture.** `CALENDAR_TOKEN_ENC_KEY` is optional env
 * (TS-206 ships the feature dark behind the absence of its config). When
 * the key is unset the service constructs with a null key so the module
 * boots; `encrypt` / `decrypt` then throw `CalendarTokenCipherNotConfiguredError`.
 * The `CalendarSyncService` checks `resolveConfig()` and returns
 * `503 calendar_sync_not_configured` BEFORE reaching the cipher, so the
 * throw is defence-in-depth, never the user-facing failure.
 */
@Injectable()
export class CalendarTokenCipherService {
  private readonly key: Buffer | null;
  private readonly currentKeyVersion: number;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.currentKeyVersion = env.CALENDAR_TOKEN_ENC_KEY_VERSION;
    if (env.CALENDAR_TOKEN_ENC_KEY === undefined) {
      this.key = null;
      return;
    }
    const key = Buffer.from(env.CALENDAR_TOKEN_ENC_KEY, 'base64');
    // Defence in depth — env-validation already enforces 32 bytes via the
    // `.refine()` on CALENDAR_TOKEN_ENC_KEY, but a mis-configured override
    // that bypassed validation should still fail fast at construction.
    if (key.length !== 32) {
      throw new Error('CalendarTokenCipherService: CALENDAR_TOKEN_ENC_KEY must decode to 32 bytes');
    }
    this.key = key;
  }

  /** True when a cipher key is configured (mirrors feature configuration). */
  isConfigured(): boolean {
    return this.key !== null;
  }

  /**
   * Encrypt the Google refresh token. Returns the four columns persisted
   * on `provider.provider_calendar_connections`.
   */
  encrypt(plaintext: string): {
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
    readonly authTag: Buffer;
    readonly keyVersion: number;
  } {
    if (this.key === null) {
      throw new CalendarTokenCipherNotConfiguredError();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag, keyVersion: this.currentKeyVersion };
  }

  /**
   * Decrypt a row. Fails closed on:
   *   - tampered ciphertext / IV / authTag (GCM authentication failure
   *     surfaces as a thrown Error from `final()`).
   *   - key-version mismatch (the row was encrypted under a key this
   *     process doesn't hold).
   *
   * Both failure modes throw a single typed error so callers can handle
   * them uniformly without leaking which one occurred to the network
   * surface.
   */
  decrypt(row: {
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
    readonly authTag: Buffer;
    readonly keyVersion: number;
  }): string {
    if (this.key === null) {
      throw new CalendarTokenCipherNotConfiguredError();
    }
    if (row.keyVersion !== this.currentKeyVersion) {
      throw new CalendarTokenDecryptError(
        `key version mismatch (row=${row.keyVersion}, current=${this.currentKeyVersion})`,
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new CalendarTokenDecryptError('GCM authentication failed', { cause: err });
    }
  }
}

export class CalendarTokenCipherNotConfiguredError extends Error {
  constructor() {
    super('calendar token cipher: CALENDAR_TOKEN_ENC_KEY is not configured');
    this.name = 'CalendarTokenCipherNotConfiguredError';
  }
}

export class CalendarTokenDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`calendar token decrypt: ${message}`, options);
    this.name = 'CalendarTokenDecryptError';
  }
}
