import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import { InternalSharedSecretGuard } from './internal-shared-secret.guard';

function buildEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    NODE_ENV: 'test',
    PORT: 3019,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    S3_BUCKET_NAME: 'tastesee-media-test',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: false,
    S3_UPLOAD_URL_TTL_SECONDS: 900,
    S3_DELIVERY_URL_TTL_SECONDS: 300,
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_HEADER_NAME: 'x-internal-api-key',
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
    ...overrides,
  };
  return base;
}

function buildContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('InternalSharedSecretGuard', () => {
  const expected = 'k'.repeat(40);

  it('accepts a request carrying the expected shared secret in the default header', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-internal-api-key': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is wrong', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    const ctx = buildContext({ 'x-internal-api-key': 'wrong-secret-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header value is a prefix of the expected secret (length mismatch)', () => {
    const guard = new InternalSharedSecretGuard(buildEnv());
    // The expected secret is 'k' × 40; supply 'k' × 39 — same prefix, shorter length.
    const ctx = buildContext({ 'x-internal-api-key': 'k'.repeat(39) });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('honours a custom header name configured via env', () => {
    const guard = new InternalSharedSecretGuard(
      buildEnv({ MEDIA_SCAN_EVENTS_HEADER_NAME: 'x-tns-media-events' }),
    );
    const ctx = buildContext({ 'x-tns-media-events': expected });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
