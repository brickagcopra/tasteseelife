import { Module } from '@nestjs/common';

import { EmergencyController } from './controllers/emergency.controller';
import { EmergencyService } from './services/emergency.service';

/**
 * Emergency bounded module (TS-225) — owns the family-side emergency
 * concierge-assistance surface (`POST /api/v1/concierge/emergency`). PRD
 * §5.1 Tier 3 "emergency concierge assistance"; PDD §16.1, §20.5.
 *
 * Composition:
 *   - `EmergencyController` — HTTP boundary; validates with the contract-side
 *     Zod schema, resolves the household from the token `tenantScope`,
 *     honours `Idempotency-Key`.
 *   - `EmergencyService` — opens the high-severity escalated ticket, routes
 *     it to the household's active dedicated concierge (an in-service
 *     `concierge_assignments` lookup), and pages on-call via PagerDuty.
 *
 * `PagerDutyClient` is injected from the `@Global()`
 * `PagerDutyModule.forRoot(...)` wired in `AppModule` (TS-302b extracted it
 * to `@taste-and-see/nest-pagerduty` so service-trust-safety's welfare
 * escalation path pages on-call without forking the client) — best-effort
 * Events API v2 paging (no SDK; native fetch), optional routing key, paging
 * degrades to a logged warning when unconfigured.
 */
@Module({
  controllers: [EmergencyController],
  providers: [EmergencyService],
})
export class EmergencyModule {}
