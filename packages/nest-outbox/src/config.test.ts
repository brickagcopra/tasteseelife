import { describe, expect, it } from 'vitest';

import { OutboxConfigError, validateOptions } from './config';

describe('validateOptions', () => {
  it('applies defaults for tableName / clock / idGenerator', () => {
    const validated = validateOptions({
      serviceName: 'service-subscription',
      schemaName: 'subscription',
    });

    expect(validated.serviceName).toBe('service-subscription');
    expect(validated.schemaName).toBe('subscription');
    expect(validated.tableName).toBe('outbox_events');
    expect(typeof validated.idGenerator).toBe('function');
    expect(typeof validated.clock).toBe('function');
    expect(validated.clock()).toBeInstanceOf(Date);
    expect(validated.idGenerator()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects empty serviceName', () => {
    expect(() => validateOptions({ serviceName: '', schemaName: 'subscription' })).toThrow(
      OutboxConfigError,
    );
  });

  it('rejects schemaName with uppercase characters (raw-SQL identifier)', () => {
    expect(() => validateOptions({ serviceName: 'svc', schemaName: 'Subscription' })).toThrow(
      OutboxConfigError,
    );
  });

  it('rejects schemaName with SQL injection characters', () => {
    expect(() =>
      validateOptions({
        serviceName: 'svc',
        schemaName: 'subscription"; DROP TABLE users; --',
      }),
    ).toThrow(OutboxConfigError);
  });

  it('rejects schemaName starting with a digit', () => {
    expect(() => validateOptions({ serviceName: 'svc', schemaName: '1subscription' })).toThrow(
      OutboxConfigError,
    );
  });

  it('accepts schemaName with underscores', () => {
    const validated = validateOptions({
      serviceName: 'svc',
      schemaName: 'service_subscription',
    });
    expect(validated.schemaName).toBe('service_subscription');
  });

  it('rejects tableName with non-identifier characters', () => {
    expect(() =>
      validateOptions({
        serviceName: 'svc',
        schemaName: 'subscription',
        tableName: 'outbox events',
      }),
    ).toThrow(OutboxConfigError);
  });

  it('honours overridden tableName', () => {
    const validated = validateOptions({
      serviceName: 'svc',
      schemaName: 'subscription',
      tableName: 'outbox_events_v2',
    });
    expect(validated.tableName).toBe('outbox_events_v2');
  });

  it('honours overridden idGenerator', () => {
    let counter = 0;
    const validated = validateOptions({
      serviceName: 'svc',
      schemaName: 'subscription',
      idGenerator: () => `evt_${++counter}`,
    });
    expect(validated.idGenerator()).toBe('evt_1');
    expect(validated.idGenerator()).toBe('evt_2');
  });

  it('honours overridden clock', () => {
    const fixed = new Date('2026-05-13T12:00:00.000Z');
    const validated = validateOptions({
      serviceName: 'svc',
      schemaName: 'subscription',
      clock: () => fixed,
    });
    expect(validated.clock()).toBe(fixed);
  });

  it('OutboxConfigError exposes the issues array', () => {
    try {
      validateOptions({ serviceName: '', schemaName: '1bad' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboxConfigError);
      const issues = (err as OutboxConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
