import { ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller';

function makeController(pgImpl: () => Promise<unknown>): HealthController {
  const pool = { query: vi.fn(pgImpl) } as unknown as Pool;
  return new HealthController(pool);
}

describe('HealthController', () => {
  it('liveness returns ok without touching the database', () => {
    const controller = makeController(async () => {
      throw new Error('SHOULD NOT BE CALLED');
    });
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('readiness returns ok when Postgres is healthy', async () => {
    const controller = makeController(async () => ({ rows: [{}] }));
    expect(await controller.readiness()).toEqual({ status: 'ok' });
  });

  it('readiness throws 503 when Postgres fails', async () => {
    const controller = makeController(async () => {
      throw new Error('FATAL: password authentication failed');
    });
    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness names postgres in the 503 detail', async () => {
    const controller = makeController(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      await controller.readiness();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toContain('postgres');
    }
  });
});
