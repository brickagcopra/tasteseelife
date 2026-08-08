import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller';

function makeController(
  pgImpl: () => Promise<unknown>,
  redisImpl: () => Promise<string>,
): HealthController {
  const pool = { query: vi.fn(pgImpl) } as unknown as Pool;
  const redis = { ping: vi.fn(redisImpl) } as unknown as Redis;
  return new HealthController(pool, redis);
}

describe('HealthController', () => {
  it('liveness returns ok without touching dependencies', () => {
    const controller = makeController(
      async () => {
        throw new Error('SHOULD NOT BE CALLED');
      },
      async () => 'PONG',
    );
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('readiness returns ok when both Postgres and Redis are healthy', async () => {
    const controller = makeController(
      async () => ({ rows: [{}] }),
      async () => 'PONG',
    );
    expect(await controller.readiness()).toEqual({ status: 'ok' });
  });

  it('readiness throws 503 when Postgres fails', async () => {
    const controller = makeController(
      async () => {
        throw new Error('FATAL: password authentication failed');
      },
      async () => 'PONG',
    );
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness throws 503 when Redis fails', async () => {
    const controller = makeController(
      async () => ({ rows: [] }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness throws 503 when Redis ping returns unexpected value', async () => {
    const controller = makeController(
      async () => ({ rows: [] }),
      async () => 'WAT',
    );
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness reports both dependencies when both fail', async () => {
    const controller = makeController(
      async () => {
        throw new Error('pg down');
      },
      async () => {
        throw new Error('redis down');
      },
    );
    try {
      await controller.readiness();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toContain('postgres');
      expect(body['detail']).toContain('redis');
    }
  });
});
