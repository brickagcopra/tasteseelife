import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore } from '../store/memory-store';
import { IdempotencyModule } from './idempotency.module';
import { IDEMPOTENCY_OPTIONS_TOKEN, IDEMPOTENCY_STORE_TOKEN } from './tokens';

describe('IdempotencyModule.forRoot', () => {
  it('wires the store-backend mode end-to-end', async () => {
    const store = new MemoryIdempotencyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdempotencyModule.forRoot({
          environment: 'test',
          serviceName: 'svc-x',
          backend: { kind: 'store', store },
        }),
      ],
    }).compile();
    const resolvedStore = moduleRef.get<MemoryIdempotencyStore>(IDEMPOTENCY_STORE_TOKEN);
    expect(resolvedStore).toBe(store);
    const opts = moduleRef.get(IDEMPOTENCY_OPTIONS_TOKEN) as { serviceName: string };
    expect(opts.serviceName).toBe('svc-x');
    await moduleRef.close();
  });

  it('wires the redis-client backend mode (smoke — does not actually call Redis)', async () => {
    // Fake ioredis-shaped object — we only need the constructor to succeed.
    const fakeClient = {
      set: async () => 'OK',
      get: async () => null,
      ttl: async () => 60,
      eval: async () => 0,
      on: () => undefined,
      quit: async () => undefined,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdempotencyModule.forRoot({
          environment: 'test',
          serviceName: 'svc-x',
          backend: { kind: 'redis-client', redisClient: fakeClient },
        }),
      ],
    }).compile();
    const resolved = moduleRef.get(IDEMPOTENCY_STORE_TOKEN);
    expect(resolved).toBeDefined();
    await moduleRef.close();
  });

  it('rejects invalid options at module-construction time (synchronous throw before .compile())', () => {
    expect(() =>
      IdempotencyModule.forRoot({
        environment: '',
        serviceName: 's',
        backend: { kind: 'store', store: new MemoryIdempotencyStore() },
      }),
    ).toThrow(/environment/);
  });
});
