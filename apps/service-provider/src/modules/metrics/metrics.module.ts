import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { ProviderMetricsProjectorService } from './services/provider-metrics-projector.service';
import { ProviderMetricsService } from './services/provider-metrics.service';

/**
 * Provider performance metrics read model (TS-305d).
 *
 * Two services and no controller. The write side
 * (`ProviderMetricsProjectorService`) is driven by the outbox-consumer
 * handlers; the read side (`ProviderMetricsService`) is consumed by the
 * admin dossier. **There is no metrics endpoint of its own, and that is
 * a decision rather than an omission**: the only readers are a review
 * surface and the 360 that aggregates it, and a committee weighing a
 * provider wants the numbers on the same page as the credentials, not
 * one round-trip and one more permission gate away. If a second,
 * genuinely independent reader appears, the route can be added then —
 * inventing it now would ship an ungated surface exposing a provider's
 * commercial performance with nothing asking for it.
 *
 * The projector also APPENDS `provider.metrics_updated` (TS-053-followup-4a)
 * from the globally-provided `OutboxService`, so this module declares no
 * outbox provider of its own.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProviderMetricsService, ProviderMetricsProjectorService],
  exports: [ProviderMetricsService, ProviderMetricsProjectorService],
})
export class MetricsModule {}
