import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGERDUTY_EVENTS_URL,
  DEFAULT_PAGERDUTY_TIMEOUT_MS,
  PagerDutyConfigError,
  validatePagerDutyOptions,
} from './options';

/**
 * `validatePagerDutyOptions` runs at module-definition time, so every case
 * here is a boot-time failure rather than a runtime one — the whole reason
 * the check is eager is that a misconfigured pager must not be discovered
 * at the moment someone needs the page.
 */
describe('validatePagerDutyOptions', () => {
  it('applies the endpoint + timeout defaults', () => {
    const validated = validatePagerDutyOptions({ source: 'service-trust-safety' });

    expect(validated.eventsUrl).toBe(DEFAULT_PAGERDUTY_EVENTS_URL);
    expect(validated.timeoutMs).toBe(DEFAULT_PAGERDUTY_TIMEOUT_MS);
    expect(validated.routingKey).toBeUndefined();
    expect(validated.source).toBe('service-trust-safety');
  });

  it('freezes the result so a host cannot mutate configuration post-boot', () => {
    const validated = validatePagerDutyOptions({ source: 'service-concierge' });

    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('passes through an explicit routing key, region endpoint, and timeout', () => {
    const validated = validatePagerDutyOptions({
      source: 'service-concierge',
      routingKey: 'rk_live_123',
      eventsUrl: 'https://events.eu.pagerduty.com/v2/enqueue',
      timeoutMs: 8_000,
    });

    expect(validated.routingKey).toBe('rk_live_123');
    expect(validated.eventsUrl).toBe('https://events.eu.pagerduty.com/v2/enqueue');
    expect(validated.timeoutMs).toBe(8_000);
  });

  it('rejects a missing or blank source (TS-302b made it required)', () => {
    expect(() => validatePagerDutyOptions({ source: '' })).toThrow(PagerDutyConfigError);
    expect(() => validatePagerDutyOptions({ source: '   ' })).toThrow(/non-empty string/);
    expect(() => validatePagerDutyOptions({ source: undefined as unknown as string })).toThrow(
      PagerDutyConfigError,
    );
  });

  it('rejects an empty routing key (omission is how paging is disabled)', () => {
    expect(() => validatePagerDutyOptions({ source: 'svc', routingKey: '' })).toThrow(
      /omit it to disable paging/,
    );
  });

  it('rejects a non-URL endpoint', () => {
    expect(() => validatePagerDutyOptions({ source: 'svc', eventsUrl: 'not-a-url' })).toThrow(
      /must be a valid URL/,
    );
  });

  it('rejects a non-http(s) endpoint scheme', () => {
    expect(() =>
      validatePagerDutyOptions({ source: 'svc', eventsUrl: 'ftp://events.pagerduty.com/v2' }),
    ).toThrow(/http\(s\) URL/);
  });

  it('rejects a non-positive or non-integer timeout', () => {
    expect(() => validatePagerDutyOptions({ source: 'svc', timeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => validatePagerDutyOptions({ source: 'svc', timeoutMs: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => validatePagerDutyOptions({ source: 'svc', timeoutMs: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  it('rejects a timeout beyond the 30s fail-fast ceiling', () => {
    expect(() => validatePagerDutyOptions({ source: 'svc', timeoutMs: 30_001 })).toThrow(
      /<= 30000/,
    );
    expect(validatePagerDutyOptions({ source: 'svc', timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });

  it('prefixes every error with the package name', () => {
    expect(() => validatePagerDutyOptions({ source: '' })).toThrow(
      /^@taste-and-see\/nest-pagerduty: /,
    );
  });
});
