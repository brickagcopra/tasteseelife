import { Global, Module, type FactoryProvider } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { STRIPE_SDK_TOKEN } from './kyc.constants';

/**
 * Stripe SDK provider — constructs a single `Stripe` instance per pod
 * for the service-identity KYC module.
 *
 * **Outbound credential.** `STRIPE_SECRET_KEY` is the credential the
 * SDK uses to authenticate every request to https://api.stripe.com/v1/.
 * Service-identity and service-subscription each construct their own
 * SDK instance under their own DI tokens — same key, separate
 * processes. The inbound webhook signing secret lives in
 * service-webhook (CLAUDE.md §3.5).
 *
 * **API-version pinning.** Optional. Same shape as service-subscription:
 * when present the SDK locks every outbound request to the pinned
 * version, defending against silent shifts in request/response shape
 * on a future SDK minor bump.
 *
 * **Module is `@Global()`.** The KYC module is the only consumer
 * today, but the global scope mirrors service-subscription's choice
 * and keeps the door open for future identity-domain Stripe
 * integrations (e.g. Stripe Identity for family-side name-match per
 * PRD §6.1) without rewiring cross-module imports.
 */
const stripeSdkProvider: FactoryProvider<Stripe> = {
  provide: STRIPE_SDK_TOKEN,
  inject: [ENV_TOKEN],
  useFactory: (env: Env): Stripe =>
    new Stripe(env.STRIPE_SECRET_KEY, {
      ...(env.STRIPE_API_VERSION !== undefined && {
        apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
      }),
    }),
};

@Global()
@Module({
  providers: [stripeSdkProvider],
  exports: [STRIPE_SDK_TOKEN],
})
export class KycStripeModule {}
