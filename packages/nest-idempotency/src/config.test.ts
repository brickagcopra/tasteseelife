import { describe, expect, it } from 'vitest';

import { IdempotencyConfigError, validateOptions } from './config';
import { MemoryIdempotencyStore } from './store/memory-store';

describe('validateOptions', () => {
  it('returns a fully-populated options object on the happy path', () => {
    const store = new MemoryIdempotencyStore();
    const out = validateOptions({
      environment: 'prod',
      serviceName: 'svc',
      backend: { kind: 'store', store },
    });
    expect(out.environment).toBe('prod');
    expect(out.serviceName).toBe('svc');
    expect(out.ttlSeconds).toBe(86_400);
    expect(out.inFlightTtlSeconds).toBe(60);
    expect(typeof out.actorResolver).toBe('function');
    expect(typeof out.shouldCacheStatus).toBe('function');
    expect(out.backend.kind).toBe('store');
  });

  it('applies caller-supplied TTLs', () => {
    const store = new MemoryIdempotencyStore();
    const out = validateOptions({
      environment: 'p',
      serviceName: 's',
      ttlSeconds: 300,
      inFlightTtlSeconds: 30,
      backend: { kind: 'store', store },
    });
    expect(out.ttlSeconds).toBe(300);
    expect(out.inFlightTtlSeconds).toBe(30);
  });

  it('throws when environment is empty', () => {
    const store = new MemoryIdempotencyStore();
    expect(() =>
      validateOptions({
        environment: '',
        serviceName: 's',
        backend: { kind: 'store', store },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when serviceName is empty', () => {
    const store = new MemoryIdempotencyStore();
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: '',
        backend: { kind: 'store', store },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when TTL is zero or negative', () => {
    const store = new MemoryIdempotencyStore();
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        ttlSeconds: 0,
        backend: { kind: 'store', store },
      }),
    ).toThrowError(IdempotencyConfigError);
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        inFlightTtlSeconds: -1,
        backend: { kind: 'store', store },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when inFlightTtlSeconds exceeds ttlSeconds (logical guard)', () => {
    const store = new MemoryIdempotencyStore();
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        ttlSeconds: 60,
        inFlightTtlSeconds: 120,
        backend: { kind: 'store', store },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when redis-url backend is missing the URL', () => {
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        backend: { kind: 'redis-url', redisUrl: '' },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when redis-client backend is missing the client', () => {
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        backend: { kind: 'redis-client', redisClient: null as unknown },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('throws when store backend is missing the required methods', () => {
    expect(() =>
      validateOptions({
        environment: 'p',
        serviceName: 's',
        backend: { kind: 'store', store: {} as unknown as MemoryIdempotencyStore },
      }),
    ).toThrowError(IdempotencyConfigError);
  });

  it('collects multiple issues into a single error', () => {
    try {
      validateOptions({
        environment: '',
        serviceName: '',
        backend: { kind: 'redis-url', redisUrl: '' },
      });
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof IdempotencyConfigError)) throw err;
      expect(err.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('honours a custom actorResolver', () => {
    const store = new MemoryIdempotencyStore();
    const out = validateOptions({
      environment: 'p',
      serviceName: 's',
      actorResolver: () => 'tenant_42',
      backend: { kind: 'store', store },
    });
    expect(out.actorResolver({})).toBe('tenant_42');
  });

  it('default actorResolver reads requestContext.userId, then user.id, else null', () => {
    const store = new MemoryIdempotencyStore();
    const { actorResolver } = validateOptions({
      environment: 'p',
      serviceName: 's',
      backend: { kind: 'store', store },
    });
    expect(actorResolver({ requestContext: { userId: 'u_abc' } })).toBe('u_abc');
    expect(actorResolver({ user: { id: 'u_def' } })).toBe('u_def');
    expect(actorResolver({})).toBeNull();
  });

  it('default shouldCacheStatus caches 2xx + 4xx, rejects 5xx', () => {
    const store = new MemoryIdempotencyStore();
    const { shouldCacheStatus } = validateOptions({
      environment: 'p',
      serviceName: 's',
      backend: { kind: 'store', store },
    });
    expect(shouldCacheStatus(200)).toBe(true);
    expect(shouldCacheStatus(201)).toBe(true);
    expect(shouldCacheStatus(400)).toBe(true);
    expect(shouldCacheStatus(409)).toBe(true);
    expect(shouldCacheStatus(404)).toBe(true);
    expect(shouldCacheStatus(500)).toBe(false);
    expect(shouldCacheStatus(502)).toBe(false);
    expect(shouldCacheStatus(599)).toBe(false);
  });
});
