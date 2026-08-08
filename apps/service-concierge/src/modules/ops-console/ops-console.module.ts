import { Module } from '@nestjs/common';

import { OpsConsoleController } from './controllers/ops-console.controller';
import { OpsConsoleService } from './services/ops-console.service';

/**
 * Ops-console bounded module (TS-224; PRD §10.6; PDD §10.6) — the
 * internal-staff back-office for the concierge ticket queue TS-223 fills.
 *
 * Composition:
 *   - `OpsConsoleController` — admin HTTP boundary. Gated on `concierge:read`
 *     (queue + detail reads) / `concierge:write` (transition / escalate /
 *     add-note) via `@RequirePermissions(...)` + `PermissionGuard`; honours
 *     `Idempotency-Key` on the mutations.
 *   - `OpsConsoleService` — the SLA-ordered queue read, the ticket-detail +
 *     notes timeline read, and the status-transition / escalation / add-note
 *     mutations against `concierge_tickets` + `concierge_ticket_notes`.
 */
@Module({
  controllers: [OpsConsoleController],
  providers: [OpsConsoleService],
  exports: [OpsConsoleService],
})
export class OpsConsoleModule {}
