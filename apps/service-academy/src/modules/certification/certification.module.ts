import { Module } from '@nestjs/common';

import { CertificationAdminController } from './controllers/certification-admin.controller';
import { CertificationVerifyController } from './controllers/certification-verify.controller';
import { CertificatePdfStore } from './services/certificate-pdf-store';
import { CertificationService } from './services/certification.service';

/**
 * Certification bounded module (TS-255; PRD §9.3; PDD §15.2) — the Cooking
 * Academy certification issuance + verification surface.
 *
 * Two surfaces:
 *   - `CertificationAdminController` / `CertificationService` — admin issuance,
 *     listing, detail, and revocation, gated on `academy:read` / `academy:write`.
 *     `AcademyCertification` is per-student (flows through the TS-141 gate); the
 *     seeded admin RequestContext satisfies the gate and the service applies the
 *     query-param filters (admins act cross-student).
 *   - `CertificationVerifyController` — the PUBLIC `/verify/cert/:token` page
 *     (no auth), returning the PII-minimised verification view. Wraps the read
 *     in `runWithoutTenantContext` (anonymous read of a scoped model).
 *
 * `CertificatePdfStore` is stub-mode in Phase 1 (the live S3 PUT needs
 * `@aws-sdk/client-s3` approved — TS-255-followup-2); the PDF render itself
 * (`pdfkit`) is real. The provider-tier-eligibility sync (`provider-svc`,
 * PDD §15.2) is the carved follow-up TS-255-followup-4.
 */
@Module({
  controllers: [CertificationAdminController, CertificationVerifyController],
  providers: [CertificationService, CertificatePdfStore],
  exports: [CertificationService],
})
export class CertificationModule {}
