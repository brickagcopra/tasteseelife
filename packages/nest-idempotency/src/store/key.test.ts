import { describe, expect, it } from 'vitest';

import { formatIdempotencyKey, hashRequestBody } from './key';

describe('formatIdempotencyKey', () => {
  it('produces a deterministic five-segment colon-separated key', () => {
    const key = formatIdempotencyKey({
      environment: 'prod',
      serviceName: 'service-subscription',
      actor: 'user_abc',
      rawKey: 'idem_12345',
    });
    const segments = key.split(':');
    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe('prod');
    expect(segments[1]).toBe('service-subscription');
    expect(segments[2]).toBe('idempotency');
    expect(segments[3]).toBe('user_abc');
    expect(segments[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same key for the same inputs (deterministic across calls)', () => {
    const a = formatIdempotencyKey({
      environment: 'prod',
      serviceName: 'svc',
      actor: 'u1',
      rawKey: 'k',
    });
    const b = formatIdempotencyKey({
      environment: 'prod',
      serviceName: 'svc',
      actor: 'u1',
      rawKey: 'k',
    });
    expect(a).toBe(b);
  });

  it('trims raw-key whitespace before hashing', () => {
    const trimmed = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'u',
      rawKey: 'idem_abc',
    });
    const padded = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'u',
      rawKey: '  idem_abc  ',
    });
    expect(trimmed).toBe(padded);
  });

  it('produces different keys when actors differ (cross-user isolation)', () => {
    const a = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'user_a',
      rawKey: 'shared',
    });
    const b = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'user_b',
      rawKey: 'shared',
    });
    expect(a).not.toBe(b);
  });

  it('produces different keys when environments differ (cross-env isolation)', () => {
    const dev = formatIdempotencyKey({
      environment: 'dev',
      serviceName: 's',
      actor: 'u',
      rawKey: 'k',
    });
    const prod = formatIdempotencyKey({
      environment: 'prod',
      serviceName: 's',
      actor: 'u',
      rawKey: 'k',
    });
    expect(dev).not.toBe(prod);
  });

  it('rejects empty segments (bootstrap misconfig — hard throw)', () => {
    expect(() =>
      formatIdempotencyKey({ environment: '', serviceName: 's', actor: 'u', rawKey: 'k' }),
    ).toThrow(/environment/);
    expect(() =>
      formatIdempotencyKey({ environment: 'p', serviceName: '', actor: 'u', rawKey: 'k' }),
    ).toThrow(/serviceName/);
    expect(() =>
      formatIdempotencyKey({ environment: 'p', serviceName: 's', actor: '', rawKey: 'k' }),
    ).toThrow(/actor/);
  });

  it('rejects segments containing the delimiter or whitespace', () => {
    expect(() =>
      formatIdempotencyKey({
        environment: 'pr:od',
        serviceName: 's',
        actor: 'u',
        rawKey: 'k',
      }),
    ).toThrow(/environment/);
    expect(() =>
      formatIdempotencyKey({
        environment: 'prod',
        serviceName: 's vc',
        actor: 'u',
        rawKey: 'k',
      }),
    ).toThrow(/serviceName/);
  });

  it('encodes rawKey of any length to a fixed 64-char hex hash', () => {
    const short = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'u',
      rawKey: 'x',
    });
    const long = formatIdempotencyKey({
      environment: 'p',
      serviceName: 's',
      actor: 'u',
      rawKey: 'x'.repeat(10_000),
    });
    expect(short.split(':')[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(long.split(':')[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(short).not.toBe(long);
  });
});

describe('hashRequestBody', () => {
  it('returns a 64-char hex SHA-256', () => {
    const h = hashRequestBody({ planId: 'plan_tier1', email: 'a@b.c' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same object', () => {
    const a = hashRequestBody({ a: 1, b: 'two' });
    const b = hashRequestBody({ a: 1, b: 'two' });
    expect(a).toBe(b);
  });

  it('returns different hashes when any field differs', () => {
    const a = hashRequestBody({ planId: 'plan_tier1' });
    const b = hashRequestBody({ planId: 'plan_tier2' });
    expect(a).not.toBe(b);
  });

  it('hashes undefined body as the empty-string SHA-256', () => {
    const empty = hashRequestBody(undefined);
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(empty).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles arrays + primitives', () => {
    const arr = hashRequestBody([1, 2, 3]);
    const same = hashRequestBody([1, 2, 3]);
    const different = hashRequestBody([1, 2, 4]);
    const prim = hashRequestBody(42);
    expect(arr).toBe(same);
    expect(arr).not.toBe(different);
    expect(prim).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces stable hash across calls for objects with same insertion order', () => {
    // We do NOT canonicalise key order — clients are expected to retry
    // with the same serialised body. Different insertion order yields
    // different hashes (the same-key-different-body check fires, which
    // surfaces the client bug).
    const a = hashRequestBody({ a: 1, b: 2 });
    const reordered = hashRequestBody({ b: 2, a: 1 });
    expect(a).not.toBe(reordered);
  });
});
