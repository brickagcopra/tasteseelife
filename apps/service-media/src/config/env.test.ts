import { describe, expect, it } from 'vitest';

import { EnvValidationError, isS3StubMode, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11). The test
 * surface is small but load-bearing — every other module assumes a
 * validated `Env`.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    S3_BUCKET_NAME: 'tastesee-media-dev',
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3019);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.S3_ENDPOINT_URL).toBeUndefined();
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_UPLOAD_URL_TTL_SECONDS).toBe(900);
    expect(env.S3_DELIVERY_URL_TTL_SECONDS).toBe(300);
    expect(env.MEDIA_SCAN_EVENTS_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects a missing JWT_ACCESS_SECRET', () => {
    const { JWT_ACCESS_SECRET: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects a missing S3_BUCKET_NAME', () => {
    const { S3_BUCKET_NAME: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects an S3 bucket longer than 63 characters', () => {
    expect(() => loadEnv({ ...baseEnv, S3_BUCKET_NAME: 'b'.repeat(64) })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an S3 signing secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, S3_SIGNING_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects an S3_ENDPOINT_URL that is not a URL', () => {
    expect(() => loadEnv({ ...baseEnv, S3_ENDPOINT_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('coerces S3_FORCE_PATH_STYLE from string to boolean', () => {
    const env = loadEnv({ ...baseEnv, S3_FORCE_PATH_STYLE: 'true' });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('coerces the upload URL TTL from string to integer', () => {
    const env = loadEnv({ ...baseEnv, S3_UPLOAD_URL_TTL_SECONDS: '600' });
    expect(env.S3_UPLOAD_URL_TTL_SECONDS).toBe(600);
  });

  it('rejects an upload URL TTL above one hour', () => {
    expect(() => loadEnv({ ...baseEnv, S3_UPLOAD_URL_TTL_SECONDS: '3601' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an upload URL TTL of zero', () => {
    expect(() => loadEnv({ ...baseEnv, S3_UPLOAD_URL_TTL_SECONDS: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a MEDIA_SCAN_EVENTS_API_KEY shorter than 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, MEDIA_SCAN_EVENTS_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('honours custom port', () => {
    const env = loadEnv({ ...baseEnv, PORT: '4444' });
    expect(env.PORT).toBe(4444);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, NOT_A_REAL_VAR: 'oops' } as Record<string, string>);
    expect((env as Record<string, unknown>).NOT_A_REAL_VAR).toBeUndefined();
  });

  it('honours a custom MEDIA_SCAN_EVENTS_HEADER_NAME', () => {
    const env = loadEnv({
      ...baseEnv,
      MEDIA_SCAN_EVENTS_HEADER_NAME: 'x-tns-media',
    });
    expect(env.MEDIA_SCAN_EVENTS_HEADER_NAME).toBe('x-tns-media');
  });
});

describe('isS3StubMode', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    S3_BUCKET_NAME: 'tastesee-media-dev',
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
  } as const;

  it('is true when no access key is supplied', () => {
    const env = loadEnv({ ...baseEnv });
    expect(isS3StubMode(env)).toBe(true);
  });

  it('is true when only an access key is supplied (no secret)', () => {
    const env = loadEnv({ ...baseEnv, S3_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    expect(isS3StubMode(env)).toBe(true);
  });

  it('is false when both access key and secret are supplied', () => {
    const env = loadEnv({
      ...baseEnv,
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret-value',
    });
    expect(isS3StubMode(env)).toBe(false);
  });
});
