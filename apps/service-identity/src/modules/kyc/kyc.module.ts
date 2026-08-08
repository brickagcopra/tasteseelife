import { Module } from '@nestjs/common';

import { KycController } from './controllers/kyc.controller';
import { KycMetrics } from './kyc-metrics';
import { KycPayloadCipherService } from './services/kyc-payload-cipher.service';
import { KycService } from './services/kyc.service';
import { StripeIdentityClient } from './services/stripe-identity.client';
import { KycStripeModule } from './stripe.module';

/**
 * KYC bounded module — owns the Stripe Identity verification surface
 * (TS-026). PDD §11.1 / §16.2 designate this as the platform's light
 * KYC vendor for providers; family-side name-match per PRD §6.1 is a
 * different Stripe surface and lands in a follow-up.
 *
 * Imports `KycStripeModule` for the per-pod Stripe SDK instance. The
 * controller pulls `KycService` + the `ENV_TOKEN` config; the service
 * wires the cipher, the Stripe client, and Prisma.
 *
 * No exports today — nothing outside this module consumes KYC state
 * directly. Provider-tier promotion (TS-051) will likely read via a
 * thin service surface added here when the consumer arrives.
 */
@Module({
  imports: [KycStripeModule],
  controllers: [KycController],
  providers: [KycService, KycPayloadCipherService, StripeIdentityClient, KycMetrics],
})
export class KycModule {}
