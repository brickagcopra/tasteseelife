import { Module } from '@nestjs/common';

import { CertificationsModule } from '../certifications/certifications.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ProfileModule } from '../profile/profile.module';

import { ProviderDossierController } from './controllers/provider-dossier.controller';
import { ProviderDossierService } from './services/provider-dossier.service';

/**
 * Dossier bounded module (TS-305a) — owns the admin read that
 * assembles one provider's review packet.
 *
 * Composition:
 *   - `ProviderDossierController` — `GET /api/v1/admin/providers/
 *     :providerId/dossier`, gated `provider:read`.
 *   - `ProviderDossierService` — composes the profile, certification,
 *     and tier reads plus the background-check verdict projection.
 *
 * **Why a module and not another handler on `CertificationsController`.**
 * That controller already carries the public catalog read, the
 * provider self-view, and five ops write paths across three audiences;
 * the dossier is a fourth. More concretely, the dossier reads across
 * `ProfileModule` and `CertificationsModule` — hanging it off either
 * one would make that module depend on the other for a surface neither
 * owns. A composition module that imports both keeps the dependency
 * pointing one way.
 *
 * Imports `CertificationsModule` (for `ProviderCertificationsService` +
 * `TierPromotionService`), `ProfileModule` (for
 * `ProviderProfileService`) and `MetricsModule` (TS-305d, for
 * `ProviderMetricsService`) — both already export what this needs, so
 * no existing module changed shape. `PrismaService` comes from the
 * global `PrismaModule`.
 *
 * Exports nothing: the dossier is a leaf read surface. If the gateway
 * ever needs it in-process, it goes over HTTP like every other
 * cross-service read (CLAUDE.md §2.3).
 */
@Module({
  imports: [CertificationsModule, ProfileModule, MetricsModule],
  controllers: [ProviderDossierController],
  providers: [ProviderDossierService],
})
export class DossierModule {}
