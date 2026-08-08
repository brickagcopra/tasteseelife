import { Global, Module } from '@nestjs/common';

import { WebhookMetrics } from './webhook-metrics';

/**
 * Service-local global module exposing the domain `WebhookMetrics`
 * instruments (TS-022-followup-3a-followup-1).
 *
 * The shared `@taste-and-see/nest-observability` package owns the boilerplate
 * (the `/metrics` scrape controller + the global `HttpMetricsInterceptor`),
 * but domain-metric classes stay service-local — they are domain-specific,
 * not boilerplate. `WebhookMetrics` is injected by BOTH `StripeWebhookModule`
 * and `CheckrWebhookModule` controllers, so this module is `@Global()` +
 * exports the provider, letting both feature modules inject it without each
 * importing a module (mirroring how `TenantContextModule` is global in this
 * service). Previously this wiring lived alongside the now-lifted scrape +
 * interceptor copies in `observability.module.ts` (TS-041a-followup-4).
 */
@Global()
@Module({
  providers: [WebhookMetrics],
  exports: [WebhookMetrics],
})
export class WebhookMetricsModule {}
