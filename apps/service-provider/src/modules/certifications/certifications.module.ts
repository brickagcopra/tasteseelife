import { Module } from '@nestjs/common';

import { CertificationsController } from './controllers/certifications.controller';
import { CertificationsCatalogService } from './services/certifications-catalog.service';
import { CertificationsMetrics } from './services/certifications-metrics';
import { ProviderCertificationsService } from './services/provider-certifications.service';
import { TierPromotionService } from './services/tier-promotion.service';

/**
 * Certifications bounded module — owns the per-provider credential
 * surface + tier-promotion machinery (TS-052).
 *
 * Composition:
 *   - `CertificationsController` — public catalog read, provider
 *     self-view, ops admin endpoints (grant / revoke / tier
 *     evaluate / override / history).
 *   - `CertificationsCatalogService` — read-only catalog access.
 *   - `ProviderCertificationsService` — per-provider grant /
 *     revoke / list of issuance rows.
 *   - `TierPromotionService` — eligibility rules + append-only
 *     transition log.
 *   - `CertificationsMetrics` — Prometheus instruments for the four
 *     write paths (grant / revoke / tier evaluate / tier override)
 *     (TS-052-followup-9).
 *
 * Imported by `AppModule`. Nothing outside this module consumes
 * certification / tier state directly today; future consumers
 * (search-indexer at TS-053; family-portal at TS-121; admin tooling
 * at TS-127) can either depend on this module's exports or read via
 * the gateway BFF (TS-140).
 */
@Module({
  controllers: [CertificationsController],
  providers: [
    CertificationsCatalogService,
    CertificationsMetrics,
    ProviderCertificationsService,
    TierPromotionService,
  ],
  exports: [CertificationsCatalogService, ProviderCertificationsService, TierPromotionService],
})
export class CertificationsModule {}
