import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Certificate PDF storage (TS-255; PDD §15.2 — "stored in S3").
 *
 * **Stub-mode posture (mirrors `service-media`'s `SignedUrlIssuerService`,
 * TS-110).** The live S3 `PutObject` wiring needs `@aws-sdk/client-s3` added to
 * the approved-libraries list (CLAUDE.md §13) — exactly the dependency
 * `service-media` is still deferring under TS-110-followup-2. Until that lands,
 * this store computes the deterministic object key (so the
 * `AcademyCertification.certificatePdfKey` column is populated + meaningful) and
 * logs the would-be upload at debug level WITHOUT shipping bytes anywhere. The
 * live PUT is the carved follow-up **TS-255-followup-2**.
 *
 * The key is deterministic from `(env, certificationId, issue month)` — the
 * `service-media` key shape — so the Phase-3 S3 lifecycle rules can target
 * `academy_certificate/<year>/<month>/` prefixes, and a re-render (idempotent
 * re-issue) overwrites the same key rather than orphaning a copy.
 */
@Injectable()
export class CertificatePdfStore {
  private readonly logger = new Logger(CertificatePdfStore.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Whether the store is shipping bytes to a real bucket. Always `false` in
   * Phase 1 (stub mode) — exposed so callers / tests can assert the honest
   * posture and so the live wiring (TS-255-followup-2) has a seam to flip.
   */
  get liveMode(): boolean {
    return false;
  }

  /**
   * Deterministic S3 object key for a certificate PDF. Shape:
   * `{env}/academy_certificate/{YYYY}/{MM}/{certificationId}.pdf`.
   */
  buildCertificateKey(args: { readonly certificationId: string; readonly now: Date }): string {
    const year = String(args.now.getUTCFullYear()).padStart(4, '0');
    const month = String(args.now.getUTCMonth() + 1).padStart(2, '0');
    return `${this.env.NODE_ENV}/academy_certificate/${year}/${month}/${args.certificationId}.pdf`;
  }

  /**
   * "Store" the rendered PDF. In stub mode this is a debug log + no-op; the live
   * adapter (TS-255-followup-2) issues an S3 `PutObject` with
   * `Content-Type: application/pdf` against the certificates bucket. Returns the
   * key so the caller persists it on the certification row.
   */
  async store(input: { readonly key: string; readonly bytes: Buffer }): Promise<string> {
    if (!this.liveMode) {
      this.logger.debug(
        `certificate PDF store (stub): would upload ${input.bytes.byteLength} bytes to key '${input.key}' — live S3 PUT deferred to TS-255-followup-2`,
      );
      return input.key;
    }
    // CLAUDE-TODO(TS-255-followup-2): live S3 PutObject once @aws-sdk/client-s3
    // is approved (CLAUDE.md §13). Unreachable while liveMode is hardcoded false.
    return input.key;
  }
}
