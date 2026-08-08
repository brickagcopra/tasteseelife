import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OUTBOX_CONSUMER_REDIS_TOKEN } from '@taste-and-see/nest-outbox-consumer';
import type { Redis } from 'ioredis';

/**
 * Kubernetes liveness + readiness probes (PDD §20.2).
 *
 * `/healthz` is liveness: returns ok unconditionally. A transient
 * Redis blip should NOT restart the pod — the consumer SDK recovers
 * on the next cycle.
 *
 * `/readyz` is readiness: probes the Redis client with `PING`. The
 * service-provider / service-search HTTP hops are NOT probed —
 * either being unavailable is a request-time problem the consumer
 * SDK retries through, not a pod-level "drop me from rotation"
 * signal.
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

  constructor(@Inject(OUTBOX_CONSUMER_REDIS_TOKEN) private readonly redis: Redis) {}

  @Get('healthz')
  @HttpCode(200)
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(200)
  async readiness(): Promise<{ readonly status: 'ok' }> {
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new ServiceUnavailableException({
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'redis ping returned unexpected value',
        });
      }
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.error(
        `readiness check failed (redis): ${e instanceof Error ? e.name : typeof e}`,
        e instanceof Error ? e.stack : String(e),
      );
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'redis unreachable',
      });
    }

    return { status: 'ok' };
  }
}
