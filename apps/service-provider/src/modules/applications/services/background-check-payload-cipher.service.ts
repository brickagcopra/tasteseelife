import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Envelope-encryption helper for the at-rest Checkr event payload
 * (`provider.provider_background_checks.payload_*`).
 *
 * Algorithm. AES-256-GCM, the modern default for symmetric AEAD.
 *   - 256-bit key (NIST SP 800-38D / FIPS 197).
 *   - 96-bit IV per call (NIST SP 800-38D §8.2).
 *   - 128-bit auth tag (GCM default, maximum safe forgery margin).
 *
 * Same shape as `KycPayloadCipherService` (TS-026) and
 * `IntakePayloadCipherService` (TS-031). The keys are
 * **independent**: a leaked KYC cipher key does not grant the
 * ability to read background-check payloads, and a leaked
 * background-check cipher key does not grant the ability to read
 * KYC payloads. Same compartmentalisation policy as the
 * `JWT_ACCESS_SECRET` vs `MFA_CHALLENGE_SECRET` split in TS-023 and
 * the independent-key choice in TS-026 / TS-031 / TS-032.
 *
 * Random IV, not a counter. IV reuse under the same key
 * catastrophically breaks GCM. Random 96-bit IVs have a birthday-
 * bound collision probability of ~2^-32 at 2^32 encryptions — well
 * past the realistic per-key encrypt count for background-check
 * payloads (one write per webhook event, lifetime measured in
 * years).
 *
 * Key versioning. The row stores `payload_key_version`, an integer
 * pointing at which key in the env-managed keyring encrypted the
 * row. Phase 1 ships with version 1; a future rotation increments
 * `BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION`, encrypts new rows
 * under the new version, and a backfill worker
 * (TS-051-followup-N) re-wraps legacy rows. `decrypt` rejects rows
 * whose `keyVersion` does not match the configured version — the
 * fail-closed rotation contract.
 *
 * No additional authenticated data (AAD). The row identifies the
 * ciphertext + IV + tag uniquely; AAD would prevent admin-initiated
 * row migration without a meaningful threat-model improvement.
 * Matches the KYC + intake cipher choices.
 */
@Injectable()
export class BackgroundCheckPayloadCipherService {
  private readonly key: Buffer;
  private readonly currentKeyVersion: number;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.key = Buffer.from(env.BACKGROUND_CHECK_PAYLOAD_ENC_KEY, 'base64');
    this.currentKeyVersion = env.BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION;
    // Defence in depth — env-validation already enforces 32 bytes
    // via the `.refine()` on BACKGROUND_CHECK_PAYLOAD_ENC_KEY, but a
    // mis-configured override that bypassed validation should still
    // fail fast at construction.
    if (this.key.length !== 32) {
      throw new Error(
        'BackgroundCheckPayloadCipherService: BACKGROUND_CHECK_PAYLOAD_ENC_KEY must decode to 32 bytes',
      );
    }
  }

  /**
   * Encrypt a plaintext (typically the JSON-stringified Checkr
   * event payload). Returns the four columns persisted on
   * `provider.provider_background_checks`.
   */
  encrypt(plaintext: string): {
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
    readonly authTag: Buffer;
    readonly keyVersion: number;
  } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag, keyVersion: this.currentKeyVersion };
  }

  /**
   * Decrypt a row. Fails closed on:
   *   - tampered ciphertext / IV / authTag (GCM authentication
   *     failure surfaces as a thrown Error from `final()`).
   *   - key-version mismatch (the row was encrypted under a key
   *     this process doesn't hold).
   *
   * Both failure modes throw a single typed error so callers can
   * handle them uniformly without leaking which one occurred to
   * the network surface.
   */
  decrypt(row: {
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
    readonly authTag: Buffer;
    readonly keyVersion: number;
  }): string {
    if (row.keyVersion !== this.currentKeyVersion) {
      throw new BackgroundCheckPayloadDecryptError(
        `key version mismatch (row=${row.keyVersion}, current=${this.currentKeyVersion})`,
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new BackgroundCheckPayloadDecryptError('GCM authentication failed', { cause: err });
    }
  }
}

export class BackgroundCheckPayloadDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`background-check payload decrypt: ${message}`, options);
    this.name = 'BackgroundCheckPayloadDecryptError';
  }
}
