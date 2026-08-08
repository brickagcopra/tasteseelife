import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ExpireCertificationResponseSchema,
  InternalCertificationRenewalsQuerySchema,
  InternalCertificationRenewalsResponseSchema,
  type ExpireCertificationResponse,
  type InternalCertificationRenewalsQuery,
  type InternalCertificationRenewalsResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { CertificationRenewalsService } from '../services/certification-renewals.service';

/**
 * Internal certification-renewal surface (TS-256; PRD §9.3; PDD §15.2).
 * Two endpoints, both consumed only by the renewal-reminder worker:
 *
 *   GET  /api/v1/internal/academy/certifications/renewals
 *     Cursor-paginated batch of ACTIVE certifications at or approaching
 *     renewal expiry (expiry past, or within `horizonDays`). The worker
 *     derives the 90/60/30/7-day reminder milestone — or the lapsed state
 *     — from each row's `expiresAt`.
 *
 *   POST /api/v1/internal/academy/certifications/:certificationId/expire
 *     The idempotent lapse flip (`active → expired`). 404 when the
 *     certification does not exist.
 *
 * **Auth model.** Pinned to a shared-secret header (configurable via
 * `ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_HEADER_NAME` /
 * `…_INTERNAL_API_KEY`), NOT the `AccessTokenGuard`. The header value IS
 * the auth model for the route (CLAUDE.md §3.5 — the Stripe-webhook
 * pattern). Mirrors service-identity's `RecipientContactsController`
 * (TS-235). Application-layer defence-in-depth alongside the TS-151
 * NetworkPolicy that further restricts the route to in-cluster callers.
 *
 * **Tenant-scoping (TS-141 enforce posture).** Both handlers run BEFORE
 * any `requestContext` exists (shared-secret, not `AccessTokenGuard`), and
 * `AcademyCertification` is a tenant-scoped model (NOT in the AppModule
 * `unscopedModels` list). So the entire handler body — including the 401
 * short-circuit — is wrapped in `runWithoutTenantContext` so the Prisma
 * extension's gate sees an explicit `exempt` frame on every code path. The
 * exempt frame is correct here: this is a cross-student internal projector
 * + a privileged lapse writer, and the caller (the worker) is in-cluster
 * and shared-secret-pinned. The grep-able reason strings name the surface.
 */
@Controller()
export class CertificationRenewalsInternalController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly renewals: CertificationRenewalsService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_API_KEY;
    this.headerName = env.ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_HEADER_NAME;
  }

  /**
   * GET /api/v1/internal/academy/certifications/renewals.
   *
   *   200 — InternalCertificationRenewalsResponse ({ certifications, nextCursor }).
   *   400 — query failed Zod validation (the ZodValidationPipe).
   *   401 — missing / wrong shared-secret header.
   */
  @Get('api/v1/internal/academy/certifications/renewals')
  @HttpCode(HttpStatus.OK)
  async listRenewals(
    @Query(new ZodValidationPipe(InternalCertificationRenewalsQuerySchema))
    query: InternalCertificationRenewalsQuery,
    @Req() request: Request,
  ): Promise<InternalCertificationRenewalsResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'academy-internal-certification-renewals',
      async () => {
        this.requireSharedSecret(request);

        const result = await this.renewals.listRenewalCandidates({
          cursor: query.cursor,
          limit: query.limit,
          horizonDays: query.horizonDays,
        });

        // Defence-in-depth — parse at the boundary so drift between the
        // service projection + the contract surfaces here, not at the worker.
        return InternalCertificationRenewalsResponseSchema.parse(result);
      },
    );
  }

  /**
   * POST /api/v1/internal/academy/certifications/:certificationId/expire.
   *
   *   200 — ExpireCertificationResponse ({ certificationId, status, changed }).
   *   401 — missing / wrong shared-secret header.
   *   404 — the certification does not exist.
   */
  @Post('api/v1/internal/academy/certifications/:certificationId/expire')
  @HttpCode(HttpStatus.OK)
  async expireCertification(
    @Param('certificationId') certificationId: string,
    @Req() request: Request,
  ): Promise<ExpireCertificationResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'academy-internal-certification-expire',
      async () => {
        this.requireSharedSecret(request);

        const result = await this.renewals.expireCertification(certificationId);
        if (result === null) {
          throw new NotFoundException({
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'Certification not found.',
          });
        }

        return ExpireCertificationResponseSchema.parse(result);
      },
    );
  }

  private requireSharedSecret(request: Request): void {
    const presented = request.header(this.headerName);
    if (!isSharedSecretValid(presented, this.internalApiKey)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal authentication required.',
      });
    }
  }
}

/**
 * Constant-time shared-secret comparison. Mirrors service-identity's
 * `RecipientContactsController` (TS-235) — length check is the early
 * reject, `timingSafeEqual` over equal-length buffers is the authoritative
 * compare.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
