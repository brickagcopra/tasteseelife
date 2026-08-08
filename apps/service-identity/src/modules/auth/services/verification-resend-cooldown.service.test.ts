import { createHash } from 'crypto';

import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';

import { VerificationResendCooldownService } from './verification-resend-cooldown.service';

const EMAIL = 'alice@example.com';

interface FakeRedis {
  set: ReturnType<typeof vi.fn>;
}

function build(
  setImpl?: (...args: unknown[]) => Promise<string | null>,
  cooldownSeconds = 60,
): { service: VerificationResendCooldownService; redis: FakeRedis } {
  const redis: FakeRedis = {
    set: vi.fn(setImpl ?? (async (): Promise<string | null> => 'OK')),
  };
  const service = new VerificationResendCooldownService(
    {
      NODE_ENV: 'test',
      VERIFICATION_RESEND_COOLDOWN_SECONDS: cooldownSeconds,
    } as unknown as Env,
    redis as unknown as Redis,
  );
  return { service, redis };
}

describe('VerificationResendCooldownService.claim', () => {
  it('allows the first request for an address', async () => {
    const { service } = build(async () => 'OK');
    await expect(service.claim(EMAIL)).resolves.toBe(true);
  });

  it('refuses a second request inside the window', async () => {
    // `SET ... NX` returns null when the key already exists — that IS the
    // cooldown, atomically, in one round trip.
    const { service } = build(async () => null);
    await expect(service.claim(EMAIL)).resolves.toBe(false);
  });

  it('uses SET NX EX so the key expires without a sweep', async () => {
    const { service, redis } = build(undefined, 90);
    await service.claim(EMAIL);
    const args = redis.set.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(['1', 'EX', 90, 'NX']);
  });

  it('namespaces the key per CLAUDE.md §3.7 and HASHES the address', async () => {
    const { service, redis } = build();
    await service.claim(EMAIL);

    const key = (redis.set.mock.calls[0] as unknown[])[0] as string;
    expect(key.startsWith('test:service-identity:verify-resend:')).toBe(true);
    // An unhashed key would make Redis a browsable list of addresses that
    // recently asked for verification — i.e. a list of new customers —
    // readable by anything with KEYS on the cluster.
    expect(key).not.toContain(EMAIL);
    expect(key).not.toContain('alice');
    expect(key).toContain(createHash('sha256').update(EMAIL).digest('hex').slice(0, 16));
  });

  it('gives two different addresses two different windows', async () => {
    const { service, redis } = build();
    await service.claim(EMAIL);
    await service.claim('bob@example.com');
    const keys = redis.set.mock.calls.map((c) => (c as unknown[])[0]);
    expect(new Set(keys).size).toBe(2);
  });

  it('FAILS OPEN when Redis is unavailable', async () => {
    // CLAUDE.md §4.3 — a Redis outage must not stop legitimate customers
    // getting a verification email. The gateway's per-IP policy is the
    // remaining layer, and the `unavailable` outcome is metered.
    const { service } = build(async () => {
      throw new Error('connection refused');
    });
    await expect(service.claim(EMAIL)).resolves.toBe(true);
  });

  it('puts no address on the failure log', async () => {
    const { service } = build(async () => {
      throw new Error('connection refused');
    });
    const lines: unknown[] = [];
    const logger = (service as unknown as { logger: { warn: unknown } }).logger;
    (logger as { warn: unknown }).warn = (...args: unknown[]): void => {
      lines.push(args);
    };

    await service.claim(EMAIL);

    // The structured payload carries the error MESSAGE and nothing else.
    // Logging the raw error object would be the mistake: ioredis attaches
    // the command arguments to some failures, which is the key — and the
    // key is the only place a caller-supplied value reaches this service.
    const structured = lines.map((l) => (l as unknown[])[0]);
    expect(structured).toEqual([{ err: 'connection refused' }]);
  });
});
