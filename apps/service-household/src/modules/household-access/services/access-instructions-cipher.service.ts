import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Envelope-encryption helper for the at-rest household-access
 * instructions payload (`household.households.access_instructions_*`).
 *
 * Algorithm. AES-256-GCM. Identical primitives to
 * `IntakePayloadCipherService` — 256-bit key, 96-bit random IV per
 * call, 128-bit auth tag, no additional authenticated data. See that
 * service's header for the full rationale; the choices here are the
 * same answers to the same questions.
 *
 * Why a SEPARATE service (and key) from the intake cipher? Threat
 * model. The intake payload holds medical-ish notes; the
 * access-instructions payload holds the means of physical entry to a
 * senior's home. A leak of either key class compromises that data
 * class only — the blast-radius decoupling justifies the second key
 * and the duplicated ~80 lines of cipher code. Within `service-
 * household` we deliberately mirror the pattern documented on
 * `IntakePayloadCipherService`: a consolidating `packages/crypto` can
 * land if a third class of payload joins the picture.
 *
 * Key versioning. The DB row stores `access_instructions_key_version`,
 * an integer pointing at which key in the env-managed keyring
 * encrypted the row. Phase 1 ships with a single key (version=1).
 * `decrypt` rejects rows whose `keyVersion` does not match the
 * configured version — the fail-closed rotation contract. A rotation
 * runbook bumps `HOUSEHOLD_ACCESS_ENC_KEY_VERSION` and runs the
 * backfill worker (captured as a TS-032 follow-up).
 */
@Injectable()
export class AccessInstructionsCipherService {
  private readonly key: Buffer;
  private readonly currentKeyVersion: number;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.key = Buffer.from(env.HOUSEHOLD_ACCESS_ENC_KEY, 'base64');
    this.currentKeyVersion = env.HOUSEHOLD_ACCESS_ENC_KEY_VERSION;
    // Defence in depth — env-validation already enforces 32 bytes via
    // the `.refine()` on HOUSEHOLD_ACCESS_ENC_KEY. A mis-configured
    // override that bypassed validation still fails fast at
    // construction rather than producing unpredictable runtime behaviour.
    if (this.key.length !== 32) {
      throw new Error(
        'AccessInstructionsCipherService: HOUSEHOLD_ACCESS_ENC_KEY must decode to 32 bytes',
      );
    }
  }

  /**
   * Encrypt a UTF-8 plaintext (the JSON-serialised access-instructions
   * payload). Returns the ciphertext, the random IV, the GCM auth tag,
   * and the key version used — exactly the four columns persisted on
   * `household.households`.
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
   *   - tampered ciphertext / IV / authTag (GCM auth fail).
   *   - key-version mismatch (the row was encrypted under a key this
   *     process does not hold).
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
      throw new AccessInstructionsDecryptError(
        `key version mismatch (row=${row.keyVersion}, current=${this.currentKeyVersion})`,
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new AccessInstructionsDecryptError('GCM authentication failed', { cause: err });
    }
  }
}

export class AccessInstructionsDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`access instructions decrypt: ${message}`, options);
    this.name = 'AccessInstructionsDecryptError';
  }
}
