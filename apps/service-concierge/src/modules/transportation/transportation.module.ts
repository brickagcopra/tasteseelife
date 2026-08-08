import { Module } from '@nestjs/common';

import { TransportationSharedSecretGuard } from '../../common/guards/transportation-shared-secret.guard';
import { TransportationController } from './controllers/transportation.controller';
import { TransportationWebhookController } from './controllers/transportation-webhook.controller';
import { TransportationService } from './services/transportation.service';

/**
 * Transportation-coordination bounded module (TS-226; PRD §5.1 Tier 3
 * "transportation coordination", §6.6; PDD §10.6) — the concierge fulfilment
 * surface for the rides a Tier-3 household needs, plus the inbound vendor
 * ride-status webhook. Sibling of the TS-227 `ScheduledEventsModule`.
 *
 * Composition:
 *   - `TransportationController` — admin HTTP boundary. Gated on
 *     `concierge:read` (list) / `concierge:write` (schedule + update) via
 *     `@RequirePermissions(...)` + `PermissionGuard`; honours `Idempotency-Key`
 *     on the mutations.
 *   - `TransportationWebhookController` — the shared-secret-pinned inbound
 *     ride-status webhook (`POST /internal/concierge/transportation/ride-events`).
 *     Wraps its body in `runWithoutTenantContext` (no `requestContext` exists
 *     for a vendor edge).
 *   - `TransportationService` — schedule / list / update / apply-webhook
 *     against `concierge_transportation_requests`, with in-service
 *     ticket-household integrity checks + the status-transition matrix + the
 *     vendor-status adapter seam.
 *   - `TransportationSharedSecretGuard` — registered as a provider so Nest can
 *     resolve it (with `ENV_TOKEN`) for the webhook's `@UseGuards(...)`.
 *
 * `externalProvider` is the Phase-3 Uber Health / Lyft Health adapter seam
 * (Phase-1 default `manual`); no external SDK is imported (TS-226-followup
 * carries the live integration + its required SDK ADR).
 */
@Module({
  controllers: [TransportationController, TransportationWebhookController],
  providers: [TransportationService, TransportationSharedSecretGuard],
  exports: [TransportationService],
})
export class TransportationModule {}
