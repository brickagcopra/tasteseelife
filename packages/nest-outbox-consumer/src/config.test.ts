import { describe, expect, it } from 'vitest';

import { ConsumerConfigError, validateOptions } from './config';

describe('@taste-and-see/nest-outbox-consumer config', () => {
  it('applies defaults when optional fields are absent', () => {
    const v = validateOptions({ consumerGroup: 'service-accounting' });
    expect(v.consumerGroup).toBe('service-accounting');
    expect(v.consumerName).toBe('default');
    expect(v.streamPrefix).toBe('events');
    expect(v.maxAttempts).toBe(10);
    expect(v.pollBlockMs).toBe(5000);
    expect(v.reclaimIdleMs).toBe(60_000);
    expect(v.pollIntervalMs).toBe(1000);
    expect(v.streamMaxLen).toBe(100_000);
    expect(typeof v.clock()).toBe('object'); // returns a Date
  });

  it('rejects a consumerGroup that is not an identifier', () => {
    expect(() => validateOptions({ consumerGroup: '' })).toThrow(ConsumerConfigError);
    expect(() => validateOptions({ consumerGroup: '123-leading-digit' })).toThrow(
      ConsumerConfigError,
    );
    expect(() => validateOptions({ consumerGroup: 'service-accounting; DROP TABLE foo' })).toThrow(
      ConsumerConfigError,
    );
  });

  it('rejects an empty consumerName', () => {
    expect(() => validateOptions({ consumerGroup: 'svc', consumerName: '' })).toThrow(
      ConsumerConfigError,
    );
  });

  it('rejects an empty streamPrefix', () => {
    expect(() => validateOptions({ consumerGroup: 'svc', streamPrefix: '' })).toThrow(
      ConsumerConfigError,
    );
  });

  it('rejects non-positive numeric fields', () => {
    expect(() => validateOptions({ consumerGroup: 'svc', maxAttempts: 0 })).toThrow(
      ConsumerConfigError,
    );
    expect(() => validateOptions({ consumerGroup: 'svc', maxAttempts: -1 })).toThrow(
      ConsumerConfigError,
    );
    expect(() => validateOptions({ consumerGroup: 'svc', maxAttempts: 1.5 })).toThrow(
      ConsumerConfigError,
    );
  });

  it('accepts non-negative numerics for ms fields', () => {
    const v = validateOptions({
      consumerGroup: 'svc',
      pollBlockMs: 0,
      reclaimIdleMs: 0,
      pollIntervalMs: 0,
    });
    expect(v.pollBlockMs).toBe(0);
    expect(v.reclaimIdleMs).toBe(0);
    expect(v.pollIntervalMs).toBe(0);
  });

  it('honours overrides for every option', () => {
    const fakeClock = (): Date => new Date('2026-05-13T12:00:00.000Z');
    const v = validateOptions({
      consumerGroup: 'service-accounting',
      consumerName: 'pod-7',
      streamPrefix: 'events-v2',
      maxAttempts: 25,
      pollBlockMs: 250,
      reclaimIdleMs: 5_000,
      pollIntervalMs: 500,
      streamMaxLen: 1_000,
      clock: fakeClock,
    });
    expect(v.consumerName).toBe('pod-7');
    expect(v.streamPrefix).toBe('events-v2');
    expect(v.maxAttempts).toBe(25);
    expect(v.pollBlockMs).toBe(250);
    expect(v.reclaimIdleMs).toBe(5_000);
    expect(v.pollIntervalMs).toBe(500);
    expect(v.streamMaxLen).toBe(1_000);
    expect(v.clock().toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('exposes issues on ConsumerConfigError for structured logging', () => {
    try {
      validateOptions({ consumerGroup: '', maxAttempts: -5 });
      expect.fail('expected validateOptions to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConsumerConfigError);
      const err = e as ConsumerConfigError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues.join(' ')).toMatch(/consumerGroup/);
      expect(err.issues.join(' ')).toMatch(/maxAttempts/);
    }
  });
});
