import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

const SECRET = 'x'.repeat(32);

const VALID: NodeJS.ProcessEnv = {
  HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3013',
  HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: SECRET,
  IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
  IDENTITY_RECIPIENT_CONTACTS_API_KEY: SECRET,
  BOOKING_SERVICE_BASE_URL: 'http://service-booking:3015',
  BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: SECRET,
  NOTIFICATION_SERVICE_BASE_URL: 'http://service-notification:3018',
  NOTIFICATION_DISPATCH_API_KEY: SECRET,
};

describe('loadEnv', () => {
  it('parses a valid env with sensible defaults', () => {
    const env = loadEnv(VALID);
    expect(env.PORT).toBe(3056);
    expect(env.WELLNESS_SUMMARY_ENABLED).toBe(true);
    expect(env.WELLNESS_SUMMARY_WINDOW_DAYS).toBe(30);
    expect(env.WELLNESS_SUMMARY_RUN_DAY_OF_MONTH).toBe(1);
    expect(env.WELLNESS_SUMMARY_RUN_HOUR_UTC).toBe(13);
    expect(env.WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT).toBe(100);
    expect(env.WELLNESS_SUMMARY_APP_NAME).toBe('Taste & See');
    expect(env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME).toBe('x-internal-api-key');
  });

  it('coerces the kill-switch string to a boolean', () => {
    expect(loadEnv({ ...VALID, WELLNESS_SUMMARY_ENABLED: 'false' }).WELLNESS_SUMMARY_ENABLED).toBe(
      false,
    );
  });

  it('rejects a window that is not 30 or 90', () => {
    expect(() => loadEnv({ ...VALID, WELLNESS_SUMMARY_WINDOW_DAYS: '45' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a 90-day window', () => {
    expect(
      loadEnv({ ...VALID, WELLNESS_SUMMARY_WINDOW_DAYS: '90' }).WELLNESS_SUMMARY_WINDOW_DAYS,
    ).toBe(90);
  });

  it('rejects a run-day above 28', () => {
    expect(() => loadEnv({ ...VALID, WELLNESS_SUMMARY_RUN_DAY_OF_MONTH: '31' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a shared secret shorter than 32 chars', () => {
    expect(() => loadEnv({ ...VALID, NOTIFICATION_DISPATCH_API_KEY: 'short' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a missing base URL', () => {
    const { HOUSEHOLD_SERVICE_BASE_URL: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it('rejects a non-URL base URL', () => {
    expect(() => loadEnv({ ...VALID, BOOKING_SERVICE_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });
});
