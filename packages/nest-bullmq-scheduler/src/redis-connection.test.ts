import { describe, expect, it } from 'vitest';

import { redisConnectionOptionsFromUrl } from './redis-connection';

/**
 * Moved here from `apps/service-booking/.../anomaly-sweep.runner.test.ts`
 * when the second copy of this function became the shared one (TS-308a-followup-1).
 */
describe('redisConnectionOptionsFromUrl', () => {
  it('parses host, port, and database', () => {
    expect(redisConnectionOptionsFromUrl('redis://cache.internal:6380/3')).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      db: 3,
      maxRetriesPerRequest: null,
    });
  });

  it('defaults the port when the URL omits it', () => {
    expect(redisConnectionOptionsFromUrl('redis://localhost')).toMatchObject({ port: 6379 });
  });

  it('carries credentials and enables TLS for rediss://', () => {
    const options = redisConnectionOptionsFromUrl('rediss://user:p%40ss@cache:6379');

    expect(options).toMatchObject({ username: 'user', password: 'p@ss' });
    expect((options as { tls?: unknown }).tls).toBeDefined();
  });

  it('leaves TLS off for plain redis://', () => {
    expect(
      (redisConnectionOptionsFromUrl('redis://cache:6379') as { tls?: unknown }).tls,
    ).toBeUndefined();
  });

  it('omits credentials entirely when the URL carries none', () => {
    const options = redisConnectionOptionsFromUrl('redis://cache:6379') as Record<string, unknown>;

    expect('username' in options).toBe(false);
    expect('password' in options).toBe(false);
  });

  it('omits db when the URL has no path segment', () => {
    const options = redisConnectionOptionsFromUrl('redis://cache:6379') as Record<string, unknown>;

    expect('db' in options).toBe(false);
  });

  it('pins maxRetriesPerRequest to null — BullMQ requires it for worker connections', () => {
    expect(redisConnectionOptionsFromUrl('redis://localhost:6379')).toMatchObject({
      maxRetriesPerRequest: null,
    });
  });
});
