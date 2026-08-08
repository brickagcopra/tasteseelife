import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

/**
 * Env validation is the boot-time gate (CLAUDE.md §17.11 — never
 * hardcode environment-dependent values). The test surface is small but
 * load-bearing — every other module assumes a validated `Env`.
 *
 * TS-031 added the intake-encryption + JWT-verification clusters; the
 * baseEnv below carries the minimum set of required values for every
 * happy-path test, and the new-key tests live in their own describe
 * block so a future env addition doesn't sprawl across the file.
 */
describe('loadEnv', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/tastesee',
    HOUSEHOLD_INTAKE_ENC_KEY: randomBytes(32).toString('base64'),
    HOUSEHOLD_ACCESS_ENC_KEY: randomBytes(32).toString('base64'),
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    REDIS_URL: 'redis://localhost:6379/0',
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'p'.repeat(48),
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'w'.repeat(48),
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'm'.repeat(48),
  } as const;

  it('accepts a well-formed environment and applies defaults', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
    expect(env.PORT).toBe(3011);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.HOUSEHOLD_INTAKE_ENC_KEY_VERSION).toBe(1);
    expect(env.HOUSEHOLD_ACCESS_ENC_KEY_VERSION).toBe(1);
    expect(env.JWT_ISSUER).toBe('taste-and-see/service-identity');
    expect(env.JWT_AUDIENCE).toBe('taste-and-see/api');
  });

  it('throws EnvValidationError when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'qa' })).toThrow(EnvValidationError);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadEnv({ ...baseEnv, PORT: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, PORT: '-1' })).toThrow(EnvValidationError);
  });

  it('coerces PORT from string to number', () => {
    const env = loadEnv({ ...baseEnv, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('ignores undeclared env keys (tolerates ambient / k8s-injected vars)', () => {
    // TS-153: a pod's process.env carries PATH/HOME + Kubernetes-injected
    // POD_* and <SERVICE>_SERVICE_HOST/_PORT vars; loadEnv strips undeclared
    // keys rather than CrashLoop on them at boot.
    const env = loadEnv({ ...baseEnv, UNKNOWN_KEY: 'x' });
    expect((env as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
  });

  it('exposes structured issues on the thrown error', () => {
    try {
      loadEnv({});
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.some((issue) => issue.path.includes('DATABASE_URL'))).toBe(true);
    }
  });

  it('formats a human-readable message that names the offending field', () => {
    try {
      loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' });
      throw new Error('loadEnv unexpectedly succeeded');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).message).toContain('DATABASE_URL');
    }
  });

  // ─── TS-031 additions ─────────────────────────────────────────────

  it('requires HOUSEHOLD_INTAKE_ENC_KEY', () => {
    const { HOUSEHOLD_INTAKE_ENC_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects HOUSEHOLD_INTAKE_ENC_KEY that does not decode to 32 bytes', () => {
    // 16 bytes (AES-128 size) is the canonical "looks plausible but wrong" case.
    const shortKey = randomBytes(16).toString('base64');
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_INTAKE_ENC_KEY: shortKey })).toThrow(
      EnvValidationError,
    );
    // Empty string is the other obvious failure mode.
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_INTAKE_ENC_KEY: '' })).toThrow(EnvValidationError);
  });

  it('coerces HOUSEHOLD_INTAKE_ENC_KEY_VERSION from string to number', () => {
    const env = loadEnv({ ...baseEnv, HOUSEHOLD_INTAKE_ENC_KEY_VERSION: '7' });
    expect(env.HOUSEHOLD_INTAKE_ENC_KEY_VERSION).toBe(7);
  });

  it('rejects a non-positive HOUSEHOLD_INTAKE_ENC_KEY_VERSION', () => {
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_INTAKE_ENC_KEY_VERSION: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('requires JWT_ACCESS_SECRET and enforces a length floor', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('honours overridden JWT_ISSUER / JWT_AUDIENCE', () => {
    const env = loadEnv({
      ...baseEnv,
      JWT_ISSUER: 'custom-issuer',
      JWT_AUDIENCE: 'custom-aud',
    });
    expect(env.JWT_ISSUER).toBe('custom-issuer');
    expect(env.JWT_AUDIENCE).toBe('custom-aud');
  });

  // ─── TS-032 additions ─────────────────────────────────────────────

  it('requires HOUSEHOLD_ACCESS_ENC_KEY', () => {
    const { HOUSEHOLD_ACCESS_ENC_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects HOUSEHOLD_ACCESS_ENC_KEY that does not decode to 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_ACCESS_ENC_KEY: shortKey })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_ACCESS_ENC_KEY: '' })).toThrow(EnvValidationError);
  });

  it('coerces HOUSEHOLD_ACCESS_ENC_KEY_VERSION from string to number', () => {
    const env = loadEnv({ ...baseEnv, HOUSEHOLD_ACCESS_ENC_KEY_VERSION: '5' });
    expect(env.HOUSEHOLD_ACCESS_ENC_KEY_VERSION).toBe(5);
  });

  it('rejects a non-positive HOUSEHOLD_ACCESS_ENC_KEY_VERSION', () => {
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_ACCESS_ENC_KEY_VERSION: '0' })).toThrow(
      EnvValidationError,
    );
  });

  it('uses INDEPENDENT intake and access keys (no shared default)', () => {
    // The two keys decode to different bytes by construction — random keys
    // in baseEnv. This test pins the contract that loadEnv does not collapse
    // them to a single value via a shared default. A future refactor that
    // accidentally read `HOUSEHOLD_INTAKE_ENC_KEY` for both would fail here.
    const env = loadEnv({ ...baseEnv });
    expect(env.HOUSEHOLD_ACCESS_ENC_KEY).not.toBe(env.HOUSEHOLD_INTAKE_ENC_KEY);
  });

  // ─── TS-044-followup-1 additions (REDIS_URL + idempotency TTLs) ──────

  it('throws EnvValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
  });

  it('rejects a non-URL REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('defaults IDEMPOTENCY_TTL_SECONDS to 86400 (24h)', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it('defaults IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS to 60', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(60);
  });

  it('coerces TTL overrides from string to integer', () => {
    const env = loadEnv({
      ...baseEnv,
      IDEMPOTENCY_TTL_SECONDS: '3600',
      IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '30',
    });
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS).toBe(30);
  });

  it('rejects a non-positive idempotency TTL', () => {
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: '-5' })).toThrow(
      EnvValidationError,
    );
  });

  // ─── TS-208 additions (visit-prep internal shared-secret) ─────────

  it('defaults HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME to the canonical header', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME).toBe(
      'x-household-visit-prep-internal-api-key',
    );
  });

  it('requires HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY and enforces a 32-char floor', () => {
    const { HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...baseEnv, HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY exactly 32 chars long', () => {
    const env = loadEnv({
      ...baseEnv,
      HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'a'.repeat(32),
    });
    expect(env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY).toHaveLength(32);
  });

  // ─── TS-235 additions (wellness-summary internal shared-secret) ────

  it('defaults HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME to the canonical header', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('requires HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY and enforces a 32-char floor', () => {
    const { HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: _omitted, ...rest } = baseEnv;
    void _omitted;
    expect(() => loadEnv({ ...rest })).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({ ...baseEnv, HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'short' }),
    ).toThrow(EnvValidationError);
  });

  it('accepts a HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY exactly 32 chars long', () => {
    const env = loadEnv({
      ...baseEnv,
      HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'a'.repeat(32),
    });
    expect(env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY).toHaveLength(32);
  });
});
