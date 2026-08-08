import { Module } from '@nestjs/common';

import { PlansController } from './controllers/plans.controller';
import { PlansService } from './services/plans.service';

/**
 * Plans bounded module — owns the read-side of the subscription plan
 * catalog (TS-040).
 *
 * Exports `PlansService` so future cross-module flows (subscription
 * checkout in TS-041 needs to verify a plan exists; admin tooling in
 * TS-127 reuses the same projection for dropdowns) can reuse it without
 * a module refactor.
 *
 * The `PrismaModule` is global, so this module only needs to declare its
 * own controllers + providers.
 */
@Module({
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
