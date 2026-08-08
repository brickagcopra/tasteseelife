import { Module } from '@nestjs/common';

import { TicketsController } from './controllers/tickets.controller';
import { TicketsService } from './services/tickets.service';

/**
 * Tickets bounded module (TS-223) — owns the family-side concierge
 * custom-request / service-request surface (`POST /api/v1/concierge/
 * requests` + the family `/me` list). PRD §6.6; PDD §10.6.
 *
 * Composition:
 *   - `TicketsController` — HTTP boundary; validates with the contract-side
 *     Zod schemas, resolves the household from the token `tenantScope`,
 *     honours `Idempotency-Key` on the submit.
 *   - `TicketsService` — persists the ticket, routes it to the household's
 *     active dedicated concierge (an in-service `concierge_assignments`
 *     lookup), and stamps the per-kind SLA. Exported so the forthcoming
 *     ops console (TS-224) can consume the ticket reads without an HTTP
 *     round-trip.
 */
@Module({
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
