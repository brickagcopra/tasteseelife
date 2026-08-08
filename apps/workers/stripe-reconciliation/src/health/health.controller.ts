import { Controller, Get, HttpCode } from '@nestjs/common';

/**
 * Kubernetes liveness + readiness probes (PDD §20.2).
 *
 * The worker has NO persistent datastore of its own — it only makes one
 * outbound HTTP call per nightly run. So both probes return ok once the
 * process has booted: there is no local dependency whose health gates
 * traffic, and a transient upstream blip should NOT restart the pod (the
 * next nightly tick recovers; a single run is best-effort + idempotent).
 * Per-run reachability is logged at run time, not surfaced here.
 */
@Controller()
export class HealthController {
  @Get('healthz')
  @HttpCode(200)
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(200)
  readiness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }
}
