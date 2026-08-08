import { Controller, Get, HttpCode } from '@nestjs/common';

/**
 * Kubernetes liveness + readiness probes (PDD §20.2).
 *
 * Unlike the identity-janitor / outbox-relay this worker has **no
 * synchronous hard dependency to probe**: it owns no database and no
 * Redis. Its only outbound dependency is media-svc's scan-event ingest,
 * which is called asynchronously per job and is retry-tolerant — a
 * transient ingest outage must NOT make the worker unready (that would
 * just thrash the pod while the work it would do on recovery is
 * idempotent). So both probes report `ok`:
 *
 *   - `/healthz` (liveness) — the process is up.
 *   - `/readyz`  (readiness) — the worker is ready to accept/drive work;
 *     it degrades gracefully when the ingest is briefly unreachable.
 *
 * (If a live job-source dependency lands — TS-201-followup-2's BullMQ
 * source — `/readyz` should grow a Redis ping, mirroring outbox-relay.)
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
