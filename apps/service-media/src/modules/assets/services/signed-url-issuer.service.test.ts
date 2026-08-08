import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../../config/env';
import { SignedUrlIssuerService } from './signed-url-issuer.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    S3_BUCKET_NAME: 'tastesee-media-test',
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
    ...stringifyOverrides(overrides),
  });
}

function stringifyOverrides(overrides: Partial<Env>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

describe('SignedUrlIssuerService.liveMode', () => {
  it('is false in the default stub-mode environment', () => {
    const env = buildEnv();
    const issuer = new SignedUrlIssuerService(env);
    expect(issuer.liveMode).toBe(false);
  });

  it('is true when live credentials are provided', () => {
    const env = buildEnv({
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret-value',
    });
    const issuer = new SignedUrlIssuerService(env);
    expect(issuer.liveMode).toBe(true);
  });
});

describe('SignedUrlIssuerService.buildStorageKey', () => {
  it('shapes the key as `{env}/{kind}/{year}/{month}/{assetId}`', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const key = issuer.buildStorageKey({
      kind: 'senior_photo',
      assetId: 'm_abc',
      now,
    });
    expect(key).toBe('development/senior_photo/2026/05/m_abc');
  });

  it('zero-pads single-digit months', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-01-09T00:00:00.000Z');
    const key = issuer.buildStorageKey({
      kind: 'memory_recipe_image',
      assetId: 'm_xyz',
      now,
    });
    expect(key).toBe('development/memory_recipe_image/2026/01/m_xyz');
  });
});

describe('SignedUrlIssuerService.issueUploadUrl (stub mode)', () => {
  it('mints a stub-shaped URL with the expected query params', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueUploadUrl({
      storageBucket: 'tastesee-media-test',
      storageKey: 'development/senior_photo/2026/05/m_abc',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });

    const url = new URL(signed.url);
    expect(url.hostname).toBe('stub-uploads.tasteandsee.example.com');
    expect(url.pathname).toBe('/development/senior_photo/2026/05/m_abc');
    expect(url.searchParams.get('expires')).toBeTruthy();
    expect(url.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.method).toBe('PUT');
    expect(signed.requiredHeaders['content-type']).toBe('image/jpeg');
    expect(signed.requiredHeaders['content-length']).toBe('1024');
  });

  it('honours the TTL — expiresAt is now + TTL', () => {
    const issuer = new SignedUrlIssuerService(buildEnv({ S3_UPLOAD_URL_TTL_SECONDS: 600 }));
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueUploadUrl({
      storageBucket: 'tastesee-media-test',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });
    expect(signed.expiresAt.getTime()).toBe(now.getTime() + 600_000);
  });

  it('a swap of the declared MIME shifts the signature (binds to payload)', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const a = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });
    const b = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/png',
      declaredSizeBytes: 1024,
      now,
    });
    const sigA = new URL(a.url).searchParams.get('sig');
    const sigB = new URL(b.url).searchParams.get('sig');
    expect(sigA).not.toBe(sigB);
  });

  it('a swap of the declared size shifts the signature', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const a = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });
    const b = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 2048,
      now,
    });
    expect(new URL(a.url).searchParams.get('sig')).not.toBe(new URL(b.url).searchParams.get('sig'));
  });

  it('verifyForTests reports true for the issuer-minted URL', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });
    expect(
      issuer.verifyForTests(signed.url, {
        method: 'PUT',
        bucket: 'b',
        key: 'k',
        payloadDigest: issuer['payloadDigest']('image/jpeg', 1024),
      }),
    ).toBe(true);
  });

  it('verifyForTests reports false when the key is forged', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueUploadUrl({
      storageBucket: 'b',
      storageKey: 'k',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      now,
    });
    expect(
      issuer.verifyForTests(signed.url, {
        method: 'PUT',
        bucket: 'b',
        key: 'different-key',
        payloadDigest: issuer['payloadDigest']('image/jpeg', 1024),
      }),
    ).toBe(false);
  });
});

describe('SignedUrlIssuerService.issueDeliveryUrl', () => {
  it('mints a stub-delivery-shaped URL', () => {
    const issuer = new SignedUrlIssuerService(buildEnv());
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueDeliveryUrl({
      storageBucket: 'tastesee-media-test',
      deliveryKey: 'development/senior_photo/2026/05/m_abc.webp',
      now,
    });
    const url = new URL(signed.url);
    expect(url.hostname).toBe('stub-delivery.tasteandsee.example.com');
    expect(url.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours a custom delivery TTL', () => {
    const issuer = new SignedUrlIssuerService(buildEnv({ S3_DELIVERY_URL_TTL_SECONDS: 120 }));
    const now = new Date('2026-05-16T12:00:00.000Z');
    const signed = issuer.issueDeliveryUrl({
      storageBucket: 'b',
      deliveryKey: 'k',
      now,
    });
    expect(signed.expiresAt.getTime()).toBe(now.getTime() + 120_000);
  });
});
