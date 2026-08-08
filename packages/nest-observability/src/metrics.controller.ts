import { Controller, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';
import { serializeMetrics } from '@taste-and-see/tracing';

/**
 * Prometheus scrape endpoint (TS-022-followup-3a-followup-1, lifted from the
 * verbatim per-service copies established in service-identity
 * TS-020-followup-1, service-provider TS-050-followup-1, service-webhook
 * TS-041a-followup-4, and worker-identity-janitor TS-022-followup-3a).
 * Serialises the current MeterProvider snapshot in Prometheus text
 * exposition format on every scrape; the `@taste-and-see/tracing` package
 * forces a fresh collection inside `serializeMetrics()` so the response
 * reflects the latest recorded values.
 *
 * The endpoint is wired unconditionally — when `OTEL_METRICS_ENABLED` is
 * `false`, `serializeMetrics()` returns the empty exposition document
 * (`'\n'`) so Prometheus does not alarm on a missing target.
 *
 * No auth gate by design: the route is intended to be exposed only on the
 * Kubernetes pod-internal network (TS-151 NetworkPolicy + the /metrics path
 * being out of the gateway's proxy allow-list). Auth would be
 * belt-and-braces; the network policy is the trust gate. This holds even
 * for services with no token-based auth model at all (e.g. service-webhook,
 * whose only auth is third-party signature verification) — the network
 * boundary is the sole control, same as for their domain routes.
 *
 * Content-Type follows OpenMetrics text format 0.0.4 — the standard
 * Prometheus header that prom-client emits and that every Prometheus
 * release since 2.5 understands. The controller is service-agnostic: the
 * service name lands on each metric's `target_info` resource attributes via
 * the MeterProvider configured in `createObservabilityBootstrap`, not here.
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return serializeMetrics();
  }
}
