import { Module } from '@nestjs/common';

import { CheckrWebhookController } from './controllers/checkr-webhook.controller';
import { BackgroundCheckDispatchService } from './services/background-check-dispatch.service';
import { CheckrIngressService } from './services/checkr-ingress.service';
import { CheckrWebhookVerifierService } from './services/checkr-webhook-verifier.service';

/**
 * Owns the inbound Checkr webhook receive path (TS-051). Mirrors
 * the shape of `StripeWebhookModule` (TS-041a): per-provider
 * verifier + ingress + controller + dispatcher triplet.
 *
 * Each inbound integration owns: (1) its own signature verifier
 * service; (2) its own `*_processed_events` table; (3) its own
 * controller route (`/api/v1/webhooks/{provider}`); (4) its own
 * pre-relay dispatcher to the matching downstream service. The
 * composition root remains a flat list of modules; no cross-talk
 * between providers.
 */
@Module({
  controllers: [CheckrWebhookController],
  providers: [CheckrWebhookVerifierService, CheckrIngressService, BackgroundCheckDispatchService],
  exports: [CheckrIngressService],
})
export class CheckrWebhookModule {}
