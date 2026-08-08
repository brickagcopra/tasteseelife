import { Global, Module, type FactoryProvider } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { STRIPE_SDK_TOKEN } from './stripe.constants';

/**
 * Stripe SDK provider — constructs a single `Stripe` instance per pod.
 *
 * **Outbound credential.** `STRIPE_SECRET_KEY` is the credential the SDK
 * uses to authenticate every request to https://api.stripe.com/v1/...
 * It's an entirely separate credential from the inbound webhook signing
 * secret in `service-webhook` (CLAUDE.md §3.5: "Stripe webhook signatures
 * verified on every webhook request" — that lives on the receiver side).
 *
 * **API-version pinning.** Optional. When present the SDK locks every
 * outbound request to that API version, defending against silent shifts
 * in request/response shape on a future SDK minor bump. Unpinned, the
 * SDK uses whatever default ships with the current SDK release. We
 * default to unpinned in dev (so a fresh `pnpm install` keeps working
 * without an env touch), pinned in deployed environments per the
 * runbook.
 *
 * **DI token.** `STRIPE_SDK_TOKEN` is a Symbol — unit tests can bind a
 * mock against the same token cleanly (avoids the `vi.mocked(Stripe)`
 * global-mock pattern). Twin of `service-webhook`'s provider.
 *
 * **Module is `@Global()`.** Multiple feature modules (subscriptions,
 * coupons in TS-043, dunning in TS-042) all need the SDK without
 * importing this module's exports — global scope avoids the cross-module
 * `imports: [StripeModule]` boilerplate.
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
export class StripeModule {}
