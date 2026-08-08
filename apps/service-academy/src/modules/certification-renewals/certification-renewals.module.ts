import { Module } from '@nestjs/common';

import { CertificationRenewalsInternalController } from './controllers/certification-renewals-internal.controller';
import { CertificationRenewalsService } from './services/certification-renewals.service';

/**
 * Certification-renewal internal module (TS-256; PRD §9.3; PDD §15.2).
 *
 * Exposes the shared-secret-pinned internal surface the renewal-reminder
 * worker consumes: the cursor-paginated at-risk certifications batch + the
 * idempotent lapse `expire` write. No authenticated (browser-facing)
 * surface — the worker is the sole caller. Kept as a sibling of
 * `CertificationModule` (rather than folded in) so the internal
 * shared-secret surface and the admin/public certification surfaces stay
 * cleanly separated, mirroring service-identity's `RecipientContactsModule`
 * (TS-235).
 */
@Module({
  controllers: [CertificationRenewalsInternalController],
  providers: [CertificationRenewalsService],
})
export class CertificationRenewalsModule {}
