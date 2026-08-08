import { Module } from '@nestjs/common';

import { CouponsModule } from '../coupons/coupons.module';

import { MySubscriptionController } from './controllers/my-subscription.controller';
import { SubscriptionsController } from './controllers/subscriptions.controller';
import { DunningExhaustionSweepRunner } from './dunning-exhaustion-sweep.runner';
import { DunningExhaustionSweepService } from './services/dunning-exhaustion-sweep.service';
import { DunningMetrics } from './services/dunning-metrics';
import { DunningService } from './services/dunning.service';
import { MySubscriptionService } from './services/my-subscription.service';
import { StripeCustomerService } from './services/stripe-customer.service';
import { SubscriptionsService } from './services/subscriptions.service';

/**
 * Subscriptions bounded module — owns the per-customer subscription
 * lifecycle (TS-041b), the dunning + pause/resume surface (TS-042),
 * and orchestrates coupon redemption (TS-043) via CouponsService.
 *
 * Provides `SubscriptionsService` + `DunningService` so future
 * cross-module flows (TS-127 admin tooling, accounting subsystem when
 * the relay routes invoice events) can reuse the orchestration logic
 * without re-implementing the Stripe call shape.
 *
 * Imports `CouponsModule` for the create-with-coupon path; the
 * CouponsService validates + lazy-creates the Stripe Coupon and the
 * SubscriptionsService persists the redemption row in the same
 * transaction as the subscription row.
 *
 * The `PrismaModule`, `StripeModule`, and `AppConfigModule` are all
 * global, so this module only declares its own controllers + providers.
 */
@Module({
  imports: [CouponsModule],
  // `MySubscriptionController` is listed FIRST so its literal `me` route is
  // registered ahead of anything on this base path that might later take a
  // `:id` parameter. Nest matches in declaration order.
  controllers: [MySubscriptionController, SubscriptionsController],
  // `DunningMetrics` (TS-042-followup-8) is the dunning-domain Prometheus
  // instrument holder, injected into `DunningService`. Service-local, not
  // lifted — domain metrics are domain-specific, not boilerplate (the shared
  // `@taste-and-see/nest-observability` package owns the /metrics scrape
  // route + the global HttpMetricsInterceptor; this is the KycMetrics /
  // WebhookMetrics precedent).
  // TS-042-followup-2 — the dunning-exhaustion sweep. `DunningGraceUntil`
  // was a deadline nothing enforced: TS-042 built `applyDunningExhaustion`
  // and TS-042-followup-4 wired the failures that stamp the deadline, but
  // nothing ever came back to check whether it had passed. The sweep lives
  // here rather than in a worker app because it needs this service's own
  // Prisma client AND its `DunningService` (CLAUDE.md §2.3; TS-293 precedent).
  providers: [
    SubscriptionsService,
    StripeCustomerService,
    DunningService,
    DunningMetrics,
    DunningExhaustionSweepService,
    DunningExhaustionSweepRunner,
    MySubscriptionService,
  ],
  exports: [SubscriptionsService, DunningService, StripeCustomerService, MySubscriptionService],
})
export class SubscriptionsModule {}
