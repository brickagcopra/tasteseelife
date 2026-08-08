import { Module } from '@nestjs/common';

import { OnboardingController } from './controllers/onboarding.controller';
import { OnboardingService } from './services/onboarding.service';

/**
 * Tier-3 onboarding bounded module (TS-228; PRD §5.1 Tier 3; PDD §10.6) — the
 * checklist-driven white-glove kickoff for a new Concierge Lifestyle household.
 *
 * Composition:
 *   - `OnboardingController` — admin ops HTTP boundary (create / list / detail /
 *     update / update-step) gated on `concierge:read` (reads) / `concierge:write`
 *     (mutations) via `@RequirePermissions(...)` + `PermissionGuard`, plus the
 *     household-scoped family read (`GET /api/v1/concierge/onboarding/me`).
 *     Honours `Idempotency-Key` on the mutations.
 *   - `OnboardingService` — create (seed the frozen template steps) / list /
 *     detail / update / update-step against `concierge_onboardings` +
 *     `concierge_onboarding_steps`, with the derived rollup status.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
