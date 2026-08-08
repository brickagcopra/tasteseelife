import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
} from '@nestjs/common';
import {
  PublicCertificationVerificationResponseSchema,
  type PublicCertificationVerificationResponse,
} from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { CertificationService } from '../services/certification.service';

/**
 * PUBLIC certificate-verification HTTP boundary (TS-255; PRD §9.3; PDD §15.2).
 *
 *   GET /verify/cert/:token   — resolve a verification token to the PII-minimised
 *                               public view (holder + course + track + dates +
 *                               status + a derived `valid` flag). No auth.
 *
 * **No authentication** — this is the diploma-style credential check anyone can
 * run by scanning the URL on a certificate. The response is a strict subset of
 * the record (never the studentUserId, PDF key, enrollment id, or internal id),
 * enforced by `PublicCertificationVerificationResponseSchema` + the service's
 * projection.
 *
 * **Tenant-scoping.** `AcademyCertification` is a tenant-scoped model, but there
 * is no authenticated `RequestContext` here, so the read would hit the TS-141
 * gate's `block` outcome. The handler wraps the service call in
 * `runWithoutTenantContext('academy-public-cert-verification', ...)` — the read
 * is intentionally anonymous + the service returns only the public subset
 * (CLAUDE.md §3.2 — every exempt scope declares why; mirrors the
 * `RecommendationsController` posture).
 *
 * A token that resolves to nothing is a flat **404** — the same response a
 * forged / expired-link token gets, so the endpoint never confirms whether a
 * given token "exists but is revoked" vs "never existed".
 */
@Controller()
export class CertificationVerifyController {
  constructor(
    private readonly certifications: CertificationService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get('verify/cert/:token')
  @HttpCode(HttpStatus.OK)
  async verify(@Param('token') token: string): Promise<PublicCertificationVerificationResponse> {
    const verification = await runWithoutTenantContext(
      this.tenantStore,
      'academy-public-cert-verification',
      async () => this.certifications.getVerificationByToken(token),
    );
    if (verification === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: 'No certificate matches this verification link.',
      });
    }
    return PublicCertificationVerificationResponseSchema.parse({ verification });
  }
}
