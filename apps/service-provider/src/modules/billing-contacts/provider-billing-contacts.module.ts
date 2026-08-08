import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProviderBillingContactsSharedSecretGuard } from '../../common/guards/provider-billing-contacts-shared-secret.guard';
import { ProviderBillingContactsController } from './controllers/provider-billing-contacts.controller';
import { ProviderBillingContactsService } from './services/provider-billing-contacts.service';

/**
 * Internal billing-contact resolution (TS-042-followup-3a1a).
 *
 * One route, one service, one guard. Kept as its own module rather than
 * folded into `ProviderDiscoveryModule` because it answers a different
 * question for a different caller under a different secret — and because
 * `ProviderDiscoveryModule` imports four feature modules it needs for the
 * discovery projection and none of which this route wants in its graph.
 */
@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [ProviderBillingContactsController],
  providers: [ProviderBillingContactsService, ProviderBillingContactsSharedSecretGuard],
})
export class ProviderBillingContactsModule {}
