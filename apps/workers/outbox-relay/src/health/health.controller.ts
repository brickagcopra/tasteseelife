import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { PG_POOL_TOKEN, REDIS_TOKEN } from '../relay/relay.module';

/**
 * Kubernetes liveness + readiness probes (PDD §20.2).
 *
 * `/healthz` is liveness: returns ok unconditionally. A transient
 * Postgres or Redis blip should NOT restart the pod — the relay
 * recovers on the next cycle.
 *
 * `/readyz` is readiness: probes the Postgres pool with `SELECT 1`
 * and the Redis client with `PING`. Both must succeed for the pod to
 * receive traffic / be considered healthy for autoscaling. The
 * timeouts on these probes are deliberately short — a 30s
 * `pg_recovery` slow query shouldn't make this endpoint hang.
 */
@Controller()
export class HealthController {
  /**
   * TS-305d-followup-2b — the readiness probe used to catch every throw
   * and return a 503 whose only trace of the cause was a `cause` field
   * that `RfcProblemFilter` then dropped from the wire. A pod that never
   * joins its Service's endpoints is the most consequential failure this
   * process can have, and it was the one failure it did not log.
   */
  private readonly logger = new Logger(HealthController.name);

  /**
   * TS-305d-followup-2b — readiness is the one endpoint whose silent
   * failure means the workload deploys and never takes traffic, so its
   * dependencies are injected by EXPLICIT token rather than by
   * compiler-emitted `design:paramtypes`. tsc emits that metadata
   * (`emitDecoratorMetadata` in `packages/tsconfig/base.json`); vitest's
   * esbuild transform does not, so under the test lanes a bare
   * constructor param type resolved to `undefined` and `/readyz`
   * answered 503 against a live, migrated Postgres. See the class
   * doc-block above and TS-305d-followup-2b1 for the platform-wide
   * version of that gap.
   */
  constructor(
    @Inject(PG_POOL_TOKEN) private readonly pool: Pool,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  @Get('healthz')
  @HttpCode(200)
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(200)
  async readiness(): Promise<{ readonly status: 'ok' }> {
    const issues: string[] = [];

    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      this.logger.error(
        `readiness check failed (postgres): ${err instanceof Error ? err.name : typeof err}`,
        err instanceof Error ? err.stack : String(err),
      );
      issues.push('postgres');
    }

    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        issues.push('redis');
      }
    } catch (err) {
      this.logger.error(
        `readiness check failed (redis): ${err instanceof Error ? err.name : typeof err}`,
        err instanceof Error ? err.stack : String(err),
      );
      issues.push('redis');
    }

    if (issues.length > 0) {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: `dependencies unavailable: ${issues.join(', ')}`,
      });
    }

    return { status: 'ok' };
  }
}
