import { Module } from '@nestjs/common';

import { CouponsModule } from '../coupons/coupons.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

import { BillingPortalController } from './controllers/billing-portal.controller';
import { CheckoutSessionsController } from './controllers/checkout-sessions.controller';
import { InvoicesController } from './controllers/invoices.controller';
import { BillingPortalService } from './services/billing-portal.service';
import { CheckoutSessionsService } from './services/checkout-sessions.service';
import { InvoicesService } from './services/invoices.service';

/**
 * Checkout bounded module (TS-124) — owns the Stripe Checkout
 * hosted-page flow + the read-through invoices surface.
 *
 * The module sits alongside `SubscriptionsModule`: it reuses the
 * existing `StripeCustomerService` (for Stripe Customer resolve), the
 * `CouponsService` (for validate + Stripe Coupon lazy-create), the
 * Prisma + Stripe + Outbox globals, and the subscription mappers — but
 * its own surface is the parallel checkout flow, not the embedded
 * PaymentIntent flow.
 *
 * Provides `CheckoutSessionsService` + `InvoicesService` for future
 * cross-module flows (admin tooling that wants to look up a session's
 * outcome, accounting-svc reconciliation that wants the local
 * subscription view of a Stripe invoice). Imports `CouponsModule` for
 * the validate + ensureStripeCoupon path and `SubscriptionsModule` for
 * `StripeCustomerService`.
 */
@Module({
  imports: [CouponsModule, SubscriptionsModule],
  controllers: [CheckoutSessionsController, InvoicesController, BillingPortalController],
  providers: [CheckoutSessionsService, InvoicesService, BillingPortalService],
  exports: [CheckoutSessionsService, InvoicesService, BillingPortalService],
})
export class CheckoutModule {}
