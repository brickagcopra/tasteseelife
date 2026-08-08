import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Envelope-encryption helper for the at-rest Stripe Identity payload
 * (`identity.kyc_records.payload_*`).
 *
 * Algorithm. AES-256-GCM, the modern default for symmetric AEAD.
 *   - 256-bit key (NIST SP 800-38D / FIPS 197).
 *   - 96-bit IV per call (NIST SP 800-38D §8.2).
 *   - 128-bit auth tag (GCM default, maximum safe forgery margin).
 *
 * Same shape as `MfaSecretCipherService` (TS-023) — the rationale for
 * each constant is identical and the tests cross-pin the invariants.
 * The keys are **independent**: a leaked MFA cipher key does not also
 * grant the ability to read KYC payloads, and vice versa. Same
 * compartmentalisation policy as the `JWT_ACCESS_SECRET` vs
 * `MFA_CHALLENGE_SECRET` split in TS-023.
 *
 * Random IV, not a counter. IV reuse under the same key
 * catastrophically breaks GCM (recovers the key stream, then the
 * auth key). Random 96-bit IVs have a birthday-bound collision
 * probability of ~2^-32 at 2^32 encryptions — well past the realistic
 * per-key encrypt count for KYC payloads (one write per webhook
 * event, lifetime measured in years).
 *
 * Key versioning. The row stores `payload_key_version`, an integer
 * pointing at which key in the env-managed keyring encrypted the row.
 * Phase 1 ships with version 1; a future rotation increments
 * `KYC_PAYLOAD_ENC_KEY_VERSION`, encrypts new rows under the new
 * version, and a backfill worker re-wraps legacy rows from the old
 * key. `decrypt` rejects rows whose `keyVersion` does not match the
 * configured version — the fail-closed rotation contract is
 * documented on the `KycRecord` model.
 *
 * No additional authenticated data (AAD). The row identifies the
 * ciphertext + IV + tag uniquely, so binding AAD to e.g. the
 * `externalId` would prevent admin-initiated row migration without
 * buying a meaningful threat-model improvement — keep the surface
 * minimal. Matches the MFA cipher choice for the same reason.
 */
@Injectable()
export class KycPayloadCipherService {
  private readonly key: Buffer;
  private readonly currentKeyVersion: number;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.key = Buffer.from(env.KYC_PAYLOAD_ENC_KEY, 'base64');
    this.currentKeyVersion = env.KYC_PAYLOAD_ENC_KEY_VERSION;
    // Defence in depth — the env-validation layer already enforces
    // 32 bytes via the `.refine()` on KYC_PAYLOAD_ENC_KEY, but a
    // mis-configured override that bypassed validation should still
    // fail fast at construction rather than producing unpredictable
    // runtime behaviour.
    if (this.key.length !== 32) {
      throw new Error('KycPayloadCipherService: KYC_PAYLOAD_ENC_KEY must decode to 32 bytes');
    }
  }

  /**
   * Encrypt a plaintext (typically the JSON-stringified Stripe
   * `verificationSession` object). Returns the four columns
   * persisted on `identity.kyc_records`.
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
   *   - key-version mismatch (the row was encrypted under a key this
   *     process doesn't hold).
   *
   * Both failure modes throw a single typed error so callers can
   * handle them uniformly without leaking which one occurred to the
   * network surface.
   */
  decrypt(row: {
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
    readonly authTag: Buffer;
    readonly keyVersion: number;
  }): string {
    if (row.keyVersion !== this.currentKeyVersion) {
      throw new KycPayloadDecryptError(
        `key version mismatch (row=${row.keyVersion}, current=${this.currentKeyVersion})`,
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new KycPayloadDecryptError('GCM authentication failed', { cause: err });
    }
  }
}

export class KycPayloadDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`KYC payload decrypt: ${message}`, options);
    this.name = 'KycPayloadDecryptError';
  }
}
