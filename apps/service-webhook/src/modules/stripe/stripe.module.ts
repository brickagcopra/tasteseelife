import { Module, type FactoryProvider } from '@nestjs/common';
import type Stripe from 'stripe';

import { ENV_TOKEN } from '../../config/config.module';

import { StripeWebhookController } from './controllers/stripe-webhook.controller';
import { StripeIdentityKycDispatchService } from './services/kyc-dispatch.service';
import { StripeIngressService } from './services/stripe-ingress.service';
import { StripeWebhookVerifierService } from './services/stripe-webhook-verifier.service';
import { createInboundOnlyStripeClient } from './stripe-client.factory';
import { STRIPE_SDK_TOKEN } from './stripe.constants';

/**
 * Stripe SDK provider — constructs a single `Stripe` instance per pod.
 *
 * The inbound-only construction (no API key, outbound requests refused
 * by an `authenticator`) lives in `stripe-client.factory.ts`, where its
 * rationale and its unit test sit together.
 *
 * Token-based DI (`STRIPE_SDK_TOKEN` Symbol) instead of class-based so
 * unit tests can inject a mock by binding to the same token — avoids
 * `vi.mocked(Stripe).webhooks.constructEvent` global-mock contortions.
 */
const stripeSdkProvider: FactoryProvider<Stripe> = {
  provide: STRIPE_SDK_TOKEN,
  inject: [ENV_TOKEN],
  useFactory: createInboundOnlyStripeClient,
};

/**
 * Owns the inbound Stripe webhook receive path. Sibling future modules
 * (`CheckrWebhookModule`, `TwilioWebhookModule`) follow the same shape
 * with their own SDK / verifier / ingress / controller triplet.
 */
@Module({
  controllers: [StripeWebhookController],
  providers: [
    stripeSdkProvider,
    StripeWebhookVerifierService,
    StripeIngressService,
    StripeIdentityKycDispatchService,
  ],
  exports: [StripeIngressService],
})
export class StripeWebhookModule {}
