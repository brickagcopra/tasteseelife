import { createHmac, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import { type Env, isS3StubMode } from '../../../config/env';

/**
 * S3 signed-URL issuance (TS-110).
 *
 * Live SDK wiring is deferred to TS-110-followup-2 — the live path
 * needs `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` added to
 * the approved-libraries list (CLAUDE.md §13). In the meantime the
 * service runs in stub mode and mints deterministic synthetic URLs
 * with an HMAC-SHA256 signature against `S3_SIGNING_SECRET`. The stub
 * URLs are recognisable (host = `stub-uploads.tasteandsee.example.com`),
 * non-routable in production, and verifiable end-to-end in tests.
 *
 * Two surfaces:
 *
 *   - `issueUploadUrl(input)` — mints a PUT-shaped upload URL with the
 *     required headers. In stub mode the URL is
 *     `https://stub-uploads.tasteandsee.example.com/<key>?expires=<unix>&sig=<hmac>`.
 *
 *   - `issueDeliveryUrl(input)` — mints a GET-shaped delivery URL for a
 *     post-processed asset. Short TTL (default 5 min). Stub URL host is
 *     `stub-delivery.tasteandsee.example.com`.
 *
 * The HMAC binds the URL to `(storageBucket, storageKey, expiresAt,
 * method)`. A test that forges a URL with a different key but the same
 * signature will fail verification; the verification helper is exported
 * for tests (live mode would use sigv4 instead).
 */
@Injectable()
export class SignedUrlIssuerService {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Whether the service is currently running in stub mode (no live AWS
   * credentials). Exposed so the asset response can carry an honest
   * `liveMode` flag back to the caller.
   */
  get liveMode(): boolean {
    return !isS3StubMode(this.env);
  }

  /**
   * Deterministic bucket name (from env). The Phase-1 model is one
   * bucket per environment; per-kind / per-tenant bucketing is a future
   * follow-up if S3 lifecycle / retention diverges per asset class.
   */
  get bucketName(): string {
    return this.env.S3_BUCKET_NAME;
  }

  /**
   * Build the canonical S3 object key for an asset. Deterministic from
   * `(env, kind, assetId)` plus the year+month bucketing so the
   * Phase-3 S3 lifecycle rules can target slices by date prefix.
   *
   * Example: `dev/senior_photo/2026/05/asset_abc`.
   */
  buildStorageKey(args: {
    readonly kind: string;
    readonly assetId: string;
    readonly now: Date;
  }): string {
    const year = String(args.now.getUTCFullYear()).padStart(4, '0');
    const month = String(args.now.getUTCMonth() + 1).padStart(2, '0');
    return `${this.env.NODE_ENV}/${args.kind}/${year}/${month}/${args.assetId}`;
  }

  /**
   * Mint an upload signed URL. In stub mode the URL is deterministic
   * from `(bucket, key, expiresAt)` plus an HMAC over the same tuple.
   * Live mode delegates to sigv4 (TS-110-followup-2).
   *
   * Returns the URL, the HTTP method, the required headers the client
   * must send (content-type pinned to the declared MIME, content-length
   * pinned to the declared size), and the expiry.
   */
  issueUploadUrl(input: {
    readonly storageBucket: string;
    readonly storageKey: string;
    readonly declaredMime: string;
    readonly declaredSizeBytes: number;
    readonly now: Date;
  }): SignedUploadUrl {
    const ttl = this.env.S3_UPLOAD_URL_TTL_SECONDS;
    const expiresAt = new Date(input.now.getTime() + ttl * 1000);
    const sig = this.sign({
      method: 'PUT',
      bucket: input.storageBucket,
      key: input.storageKey,
      expiresAt,
      payloadDigest: this.payloadDigest(input.declaredMime, input.declaredSizeBytes),
    });

    const baseHost = isS3StubMode(this.env)
      ? 'stub-uploads.tasteandsee.example.com'
      : `${input.storageBucket}.s3.${this.env.S3_REGION}.amazonaws.com`;

    const url = `https://${baseHost}/${encodeURI(input.storageKey)}?expires=${Math.floor(
      expiresAt.getTime() / 1000,
    )}&sig=${sig}`;

    return {
      url,
      method: 'PUT',
      requiredHeaders: {
        'content-type': input.declaredMime,
        'content-length': String(input.declaredSizeBytes),
      },
      expiresAt,
    };
  }

  /**
   * Mint a read-side delivery URL for a post-processed asset (status
   * = `ready`). The URL targets the `deliveryKey` variant (the Sharp
   * resize / format-conversion output), not the original bytes.
   */
  issueDeliveryUrl(input: {
    readonly storageBucket: string;
    readonly deliveryKey: string;
    readonly now: Date;
  }): SignedDeliveryUrl {
    const ttl = this.env.S3_DELIVERY_URL_TTL_SECONDS;
    const expiresAt = new Date(input.now.getTime() + ttl * 1000);
    const sig = this.sign({
      method: 'GET',
      bucket: input.storageBucket,
      key: input.deliveryKey,
      expiresAt,
      payloadDigest: '',
    });

    const baseHost = isS3StubMode(this.env)
      ? 'stub-delivery.tasteandsee.example.com'
      : `${input.storageBucket}.s3.${this.env.S3_REGION}.amazonaws.com`;

    const url = `https://${baseHost}/${encodeURI(input.deliveryKey)}?expires=${Math.floor(
      expiresAt.getTime() / 1000,
    )}&sig=${sig}`;

    return { url, expiresAt };
  }

  /**
   * Tests-only escape hatch: validate a signed URL the issuer minted.
   * Live mode (sigv4) doesn't expose a symmetric verification step;
   * tests only run against stub mode.
   */
  verifyForTests(url: string, expected: VerifyForTestsInput): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const expiresParam = parsed.searchParams.get('expires');
    const sigParam = parsed.searchParams.get('sig');
    if (expiresParam === null || sigParam === null) return false;
    const expiresAt = new Date(Number(expiresParam) * 1000);
    const expected_ = this.sign({
      method: expected.method,
      bucket: expected.bucket,
      key: expected.key,
      expiresAt,
      payloadDigest: expected.payloadDigest ?? '',
    });
    return sigParam === expected_;
  }

  /** Hash the per-method pinned headers so a swap of MIME / size shifts the signature. */
  private payloadDigest(mime: string, sizeBytes: number): string {
    return createHmac('sha256', 'service-media:payload-digest')
      .update(`${mime}|${sizeBytes}`)
      .digest('hex');
  }

  private sign(input: {
    method: 'PUT' | 'GET';
    bucket: string;
    key: string;
    expiresAt: Date;
    payloadDigest: string;
  }): string {
    return createHmac('sha256', this.env.S3_SIGNING_SECRET)
      .update(
        `${input.method}|${input.bucket}|${input.key}|${Math.floor(
          input.expiresAt.getTime() / 1000,
        )}|${input.payloadDigest}`,
      )
      .digest('hex');
  }

  /**
   * Generate a cryptographically-strong delivery key suffix for ad-hoc
   * variants — not used by the standard pipeline (which derives keys
   * deterministically), but useful for the future signed-PUT flow that
   * lets a provider replace their headshot in place.
   */
  randomKeySuffix(): string {
    return randomBytes(12).toString('hex');
  }
}

export interface SignedUploadUrl {
  readonly url: string;
  readonly method: 'PUT';
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface SignedDeliveryUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface VerifyForTestsInput {
  readonly method: 'PUT' | 'GET';
  readonly bucket: string;
  readonly key: string;
  readonly payloadDigest?: string;
}
