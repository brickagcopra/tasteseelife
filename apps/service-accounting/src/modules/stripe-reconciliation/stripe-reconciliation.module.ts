import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';

import { StripeReconciliationController } from './controllers/stripe-reconciliation.controller';
import { StripeReconciliationService } from './services/stripe-reconciliation.service';
import { StripeReportReader } from './services/stripe-report-reader.service';

/**
 * Stripe → ledger reconciliation feature module (TS-261; PRD §10.3; PDD
 * §11.2; CLAUDE.md §6). Wires the reconciliation service, the Stripe report
 * reader (stub-aware — see TS-261-followup-1 for live SDK wiring), and the
 * internal + admin controller. `PrismaModule` supplies the tenant-scoped
 * `PrismaService`; `ENV_TOKEN` + the tenant-context tokens come from the
 * global config / `TenantContextModule`.
 */
@Module({
  imports: [PrismaModule],
  providers: [StripeReconciliationService, StripeReportReader],
  controllers: [StripeReconciliationController],
})
export class StripeReconciliationModule {}
