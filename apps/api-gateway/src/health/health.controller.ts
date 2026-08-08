import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { GATEWAY_REDIS_TOKEN } from '../redis/redis.module';
import { ServiceRegistry } from '../modules/service-registry/services/service-registry';

interface LivenessResponse {
  readonly status: 'ok';
  readonly service: 'api-gateway';
  readonly version: string;
  readonly uptimeSeconds: number;
}

interface ReadinessResponse extends LivenessResponse {
  readonly checks: {
    readonly redis: 'ok';
    readonly services: Readonly<Record<string, 'configured' | 'not_configured'>>;
  };
}

/**
 * Health endpoints follow Kubernetes' liveness/readiness split:
 *
 *   /healthz — liveness. Returns 200 as long as the process is alive
 *              and can serve HTTP. Used by the kubelet to decide
 *              whether to restart the pod. Must NOT depend on external
 *              services.
 *
 *   /readyz  — readiness. Returns 200 only when the gateway can serve
 *              real traffic — Redis is reachable AND the registry is
 *              loaded. Per-service `configured` / `not_configured`
 *              flags help ops triage the env without leaking error
 *              detail to the response.
 *
 *              Phase-1 readiness does NOT actively ping each downstream
 *              service — checking N downstream `/healthz` on every
 *              readiness probe would amplify dependency failures. The
 *              configured / not_configured signal answers "is the
 *              gateway routed", which is the question the readiness
 *              probe should answer. Active downstream health-rollup
 *              is TS-140-followup-3.
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
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(GATEWAY_REDIS_TOKEN) private readonly redis: Redis,
    @Inject(ServiceRegistry) private readonly registry: ServiceRegistry,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: 'api-gateway',
      version: this.env.SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<ReadinessResponse> {
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new Error(`unexpected PING reply: ${pong}`);
      }
    } catch (err) {
      this.logger.error(
        `readiness check failed: ${err instanceof Error ? err.name : typeof err}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'redis readiness check failed',
        instance: '/readyz',
        // Driver / connection error intentionally NOT echoed back to
        // the response body — only the trace logs.
        cause: err instanceof Error ? err.message : 'unknown',
      });
    }

    const services: Record<string, 'configured' | 'not_configured'> = {};
    for (const entry of this.registry.list()) {
      services[entry.name] = entry.baseUrl === null ? 'not_configured' : 'configured';
    }

    return {
      status: 'ok',
      service: 'api-gateway',
      version: this.env.SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        redis: 'ok',
        services,
      },
    };
  }
}
