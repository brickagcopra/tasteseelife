import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PrivacyExportSliceParamsSchema,
  PrivacyExportSliceResponseSchema,
  type PrivacyExportSliceResponse,
} from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrivacyExportService } from '../services/privacy-export.service';

/**
 * Internal privacy-export contribution surface (TS-309b).
 *
 *   GET /api/v1/internal/privacy/export/:subjectKind/:subjectId
 *
 * The first implementation of the seam every owning service will mirror. Its
 * only caller is the export-assembly job, which fans out across services and
 * builds one artefact; nothing user-facing routes here, and the api-gateway
 * deliberately does NOT proxy it — an internal route reachable from the edge is
 * an internal route in name only.
 *
 * **Auth model.** A shared-secret header
 * (`IDENTITY_PRIVACY_EXPORT_HEADER_NAME` / `IDENTITY_PRIVACY_EXPORT_API_KEY`),
 * not `AccessTokenGuard` — the caller is a job, not a session (CLAUDE.md §3.5,
 * the Stripe-webhook pattern). Mirrors `RecipientContactsController` (TS-235)
 * and service-academy's renewals projector (TS-256). Application-layer
 * defence-in-depth beside the TS-151 NetworkPolicy.
 *
 * **This route does not decide whether the subject may be exported.** It
 * answers "what does identity hold about this id". Whether the requester has
 * standing — the requester/subject/verification triple, and the senior-consent
 * gate when they differ (CLAUDE.md §12) — was settled on the TS-309a row before
 * the job ever started, and re-litigating it per-service would put 21 copies of
 * one authorisation rule in 21 schemas. The secret is what stops anyone else
 * asking.
 *
 * **Tenant-scoping.** Runs before any `requestContext` exists (shared secret,
 * no `AccessTokenGuard`), and `User` is a tenant-scoped model, so the whole
 * handler body — 401 included — is wrapped in `runWithoutTenantContext` so the
 * Prisma extension sees an explicit exempt frame on every path (the TS-141
 * enforce posture).
 *
 * **Errors are not 404s.** An unknown subject id returns 200 with
 * `outcome: 'no_records'` — "we hold nothing about this person" is an answer
 * the export must record, and a 404 would be indistinguishable at the
 * aggregator from a route that has been renamed.
 */
@Controller()
export class InternalPrivacyExportController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly exports: PrivacyExportService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.IDENTITY_PRIVACY_EXPORT_API_KEY;
    this.headerName = env.IDENTITY_PRIVACY_EXPORT_HEADER_NAME;
  }

  /**
   * GET /api/v1/internal/privacy/export/:subjectKind/:subjectId.
   *
   *   200 — PrivacyExportSliceResponse (held / no_records / not_applicable).
   *   400 — path parameters failed validation.
   *   401 — missing / wrong shared-secret header.
   */
  @Get('api/v1/internal/privacy/export/:subjectKind/:subjectId')
  @HttpCode(HttpStatus.OK)
  async exportSlice(
    @Param('subjectKind') subjectKind: string,
    @Param('subjectId') subjectId: string,
    @Req() request: Request,
  ): Promise<PrivacyExportSliceResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'identity-internal-privacy-export',
      async () => {
        this.requireSharedSecret(request);

        // Validated in the handler rather than by a pipe so the 401 fires first:
        // a caller without the secret should not learn which subject kinds exist.
        const params = PrivacyExportSliceParamsSchema.parse({ subjectKind, subjectId });

        const slice = await this.exports.buildSlice(params.subjectKind, params.subjectId);

        // Re-validated at the boundary. Here that is more than drift protection:
        // the schema is `.strict()`, so a section that grew a field carrying
        // credential material fails the response instead of shipping it.
        return PrivacyExportSliceResponseSchema.parse(slice);
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
 * Constant-time shared-secret comparison — the length check is the early
 * reject, `timingSafeEqual` over equal-length buffers is the authoritative
 * compare. Same helper as every other internal route on the platform.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
