import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';

import { RedisIoAdapter } from './redis-io.adapter';

/**
 * Regression guard for TS-507.
 *
 * `@socket.io/redis-adapter`'s `createAdapter` issues a `psubscribe`
 * from its constructor. Because these clients set
 * `enableOfflineQueue: false`, that command cannot be buffered, so
 * handing it a client that is not yet writable made ioredis throw
 * *synchronously* and killed `service-messaging` during bootstrap —
 * even against a healthy Redis.
 *
 * The two properties below are what keep that from returning:
 * the clients connect lazily and are awaited to `ready` *before* the
 * adapter is built, and an unreachable Redis produces a prompt
 * rejection rather than a synchronous throw or a hang.
 */

const hoisted = vi.hoisted(() => {
  const events: string[] = [];
  return { events };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    readonly options: Record<string, unknown>;
    constructor(_url: string, options: Record<string, unknown>) {
      this.options = options;
      hoisted.events.push('construct');
    }
    duplicate(): FakeRedis {
      return new FakeRedis('', this.options);
    }
    on(): this {
      return this;
    }
    async connect(): Promise<void> {
      await Promise.resolve();
      hoisted.events.push('connect');
    }
    disconnect(): void {
      hoisted.events.push('disconnect');
    }
  }
  return { Redis: FakeRedis };
});

vi.mock('@socket.io/redis-adapter', () => ({
  createAdapter: vi.fn(() => {
    hoisted.events.push('createAdapter');
    return () => undefined;
  }),
}));

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REDIS_URL: 'redis://127.0.0.1:6379',
    REDIS_KEY_NAMESPACE_PREFIX: 'test:service-messaging:socket:',
    WS_PATH: '/socket.io',
    WS_CORS_ORIGINS: '',
    ...overrides,
  } as unknown as Env;
}

const app = {} as INestApplicationContext;

afterEach(() => {
  hoisted.events.length = 0;
});

describe('RedisIoAdapter.connectToRedis', () => {
  it('awaits both clients to ready BEFORE building the adapter', async () => {
    const adapter = new RedisIoAdapter(app, makeEnv());

    await adapter.connectToRedis();

    // Both connects must land before createAdapter's psubscribe.
    expect(hoisted.events).toStrictEqual([
      'construct',
      'construct',
      'connect',
      'connect',
      'createAdapter',
    ]);
  });

  it('constructs the clients with lazyConnect so nothing is issued on an unwritable stream', async () => {
    const { Redis } = (await import('ioredis')) as unknown as {
      Redis: new (
        url: string,
        options: Record<string, unknown>,
      ) => { options: Record<string, unknown> };
    };
    const probe = new Redis('redis://x', {});
    expect(probe).toBeDefined();

    const adapter = new RedisIoAdapter(app, makeEnv());
    await adapter.connectToRedis();

    // The offline queue stays disabled — that is deliberate, and it is
    // precisely why the connect must be awaited rather than assumed.
    const created = adapter as unknown as { pubClient: { options: Record<string, unknown> } };
    expect(created.pubClient.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });
});

describe('RedisIoAdapter.connectToRedis against an unreachable Redis', () => {
  let closedPortUrl: string;
  let probe: Server;

  it('rejects promptly instead of throwing synchronously or hanging', async () => {
    // Bind then immediately release a port so we have one that is
    // reliably refused rather than firewalled (a firewalled port would
    // test the connectTimeout path, which is slow by design).
    probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    closedPortUrl = `redis://127.0.0.1:${String(port)}`;

    vi.resetModules();
    vi.doUnmock('ioredis');
    vi.doUnmock('@socket.io/redis-adapter');
    const { RedisIoAdapter: RealAdapter } = await import('./redis-io.adapter');

    const adapter = new RealAdapter(app, makeEnv({ REDIS_URL: closedPortUrl }));

    // `.rejects` is the assertion that matters: a synchronous throw
    // (the TS-507 defect) would fail here, and so would a hang.
    await expect(adapter.connectToRedis()).rejects.toThrow(/realtime redis backplane unavailable/i);
  }, 15_000);
});
