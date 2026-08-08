import { Module } from '@nestjs/common';

import { ProviderDiscoverySharedSecretGuard } from '../../common/guards/provider-discovery-shared-secret.guard';
import { AvailabilityModule } from '../availability/availability.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { MetricsModule } from '../metrics/metrics.module';
import { CertificationsModule } from '../certifications/certifications.module';
import { ServiceAreasModule } from '../service-areas/service-areas.module';
import { ProviderDiscoveryController } from './controllers/provider-discovery.controller';
import { ProviderDiscoveryService } from './services/provider-discovery.service';

/**
 * Discovery bounded module — owns the read-only discovery-snapshot
 * surface (TS-053) the search-indexer worker pulls from.
 *
 * Composition:
 *   - `ProviderDiscoveryController` — internal-shared-secret-pinned
 *     GET endpoint at
 *     `/api/v1/internal/providers/:providerId/discovery-snapshot`.
 *   - `ProviderDiscoveryService` — materialises the row into a
 *     `ProviderDiscoveryDocument`. Reads the Provider row + joins
 *     active certifications via `ProviderCertificationsService` +
 *     the recurring-window + exception rows via
 *     `AvailabilityService` (TS-203) to project the next-7-days
 *     availability summary + the coverage polygons via
 *     `ServiceAreasService` (TS-053-followup-3) to project the
 *     representative `centroid`.
 *   - `ProviderDiscoverySharedSecretGuard` — constant-time
 *     shared-secret guard for the internal route.
 *
 * `CertificationsModule` + `AvailabilityModule` + `ServiceAreasModule` +
 * `CalendarSyncModule` are imported because the discovery service leans
 * on `ProviderCertificationsService.listForProvider`,
 * `AvailabilityService.getAvailability`, `ServiceAreasService.
 * getServiceAreas`, and `CalendarSyncService.getExternalBusyIntervals`
 * (TS-206 — to union the connected external-calendar busy intervals into
 * the next-7-days availability summary). All four source modules export
 * their service; the imports are one-way dependencies.
 */
@Module({
  imports: [
    CertificationsModule,
    AvailabilityModule,
    ServiceAreasModule,
    CalendarSyncModule,
    MetricsModule,
  ],
  controllers: [ProviderDiscoveryController],
  providers: [ProviderDiscoveryService, ProviderDiscoverySharedSecretGuard],
  exports: [ProviderDiscoveryService],
})
export class ProviderDiscoveryModule {}
