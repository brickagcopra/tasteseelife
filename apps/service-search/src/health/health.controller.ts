import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import {
  SEARCH_BACKEND_TOKEN,
  type SearchBackend,
} from '../modules/providers/services/search-backend';

interface LivenessResponse {
  readonly status: 'ok';
  readonly service: 'service-search';
  readonly version: string;
  readonly uptimeSeconds: number;
}

interface ReadinessResponse extends LivenessResponse {
  readonly checks: {
    readonly backend: 'ok';
    readonly mode: 'stub' | 'live';
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
 *   /readyz  — readiness. Returns 200 only when the service can serve
 *              real traffic — currently that means the search backend
 *              ping succeeds. Used by Service load-balancers. In stub
 *              mode (Phase 1 default) the backend is always healthy;
 *              once TS-111-followup-1 lands the live `@elastic/elasticsearch`
 *              client, this surface drives a real ES ping.
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
    @Inject(SEARCH_BACKEND_TOKEN) private readonly backend: SearchBackend,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: 'service-search',
      version: this.env.SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<ReadinessResponse> {
    try {
      await this.backend.ping();
    } catch (err) {
      this.logger.error(
        `readiness check failed: ${err instanceof Error ? err.name : typeof err}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'search backend readiness check failed',
        instance: '/readyz',
        cause: err instanceof Error ? err.message : 'unknown',
      });
    }

    return {
      status: 'ok',
      service: 'service-search',
      version: this.env.SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        backend: 'ok',
        mode: this.backend.isLiveMode() ? 'live' : 'stub',
      },
    };
  }
}
