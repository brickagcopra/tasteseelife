import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL_TOKEN } from '../janitor/janitor.module';

/**
 * Kubernetes liveness + readiness probes (PDD §20.2).
 *
 * `/healthz` is liveness: returns ok unconditionally. A transient
 * Postgres blip should NOT restart the pod — the janitor recovers on
 * the next sweep.
 *
 * `/readyz` is readiness: probes the Postgres pool with `SELECT 1`.
 * Unlike the outbox-relay this worker has no Redis dependency, so
 * Postgres is the only thing to check. The probe timeout is implicitly
 * the pool's `connectionTimeoutMillis`.
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

  constructor(@Inject(PG_POOL_TOKEN) private readonly pool: Pool) {}

  @Get('healthz')
  @HttpCode(200)
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(200)
  async readiness(): Promise<{ readonly status: 'ok' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      this.logger.error(
        `readiness check failed (postgres): ${err instanceof Error ? err.name : typeof err}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'dependencies unavailable: postgres',
      });
    }
    return { status: 'ok' };
  }
}
