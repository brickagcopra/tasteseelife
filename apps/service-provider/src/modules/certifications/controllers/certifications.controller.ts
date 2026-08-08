import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CertificationSchema,
  CertificationsListResponseSchema,
  GrantProviderCertificationRequestSchema,
  ProviderCertificationResponseSchema,
  ProviderCertificationsListResponseSchema,
  ProviderProfileResponseSchema,
  ProviderTierHistoryResponseSchema,
  RevokeProviderCertificationRequestSchema,
  TierEvaluationResponseSchema,
  TierOverrideRequestSchema,
  type Certification,
  type CertificationsListResponse,
  type GrantProviderCertificationRequest,
  type ProviderCertificationResponse,
  type ProviderCertificationsListResponse,
  type ProviderProfileResponse,
  type ProviderTierHistoryResponse,
  type RevokeProviderCertificationRequest,
  type TierEvaluationResponse,
  type TierOverrideRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { toHistoryDto, toProviderCertDto } from '../mappers/certification.mapper';
import {
  CertificationsCatalogService,
  type CertificationCatalogRecord,
} from '../services/certifications-catalog.service';
import {
  ProviderCertificationsService,
  type ProviderCertificationsFailure,
} from '../services/provider-certifications.service';
import {
  TierPromotionService,
  type TierPromotionFailure,
} from '../services/tier-promotion.service';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Certifications + tier-promotion HTTP boundary (TS-052).
 *
 * Endpoints:
 *
 *   GET /api/v1/certifications
 *     Public catalog of credentials Taste & See recognises.
 *     No auth.
 *
 *   GET /api/v1/providers/me/profile
 *     Authenticated provider self-view (provider row + active certs).
 *
 *   GET /api/v1/providers/me/certifications
 *     Authenticated provider's own certification log (active + history).
 *
 *   POST /api/v1/admin/providers/:providerId/certifications
 *     Grant a certification. Requires `provider:approve`.
 *
 *   DELETE /api/v1/admin/providers/:providerId/certifications/:certId
 *     Revoke an issuance. Requires `provider:approve`.
 *
 *   POST /api/v1/admin/providers/:providerId/tier/evaluate
 *     Recompute + optionally apply tier per current eligibility.
 *     Requires `provider:approve`.
 *
 *   POST /api/v1/admin/providers/:providerId/tier/override
 *     Manual tier override (bypasses eligibility rules). Requires
 *     `provider:approve` and `notes` for audit.
 *
 *   GET /api/v1/admin/providers/:providerId/tier/history
 *     Append-only transition log for the provider. Requires
 *     `provider:approve`.
 *
 * Auth model:
 *   - Public catalog: anonymous.
 *   - Self-view: `AccessTokenGuard` only.
 *   - Admin: `AccessTokenGuard` + `PermissionGuard` with the
 *     `provider:approve` permission gate (PDD Appendix B —
 *     `provider_ops` and `super_admin` both hold this permission).
 *
 * Idempotency: every write endpoint wears `@Idempotent()` so a
 * retried request with the same Idempotency-Key returns the cached
 * response rather than producing a duplicate grant / extra tier
 * transition.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The
 * `listCatalog` handler runs BEFORE any `requestContext` exists — the
 * endpoint is anonymous, so the `TenantContextInterceptor` cannot seed
 * a scoped frame. The body is wrapped in
 * `runWithoutTenantContext(..., 'pre-auth-certifications-list', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The
 * `Certification` model is also marked `unscoped` in
 * `TenantContextModule.forRoot`'s `unscopedModels` list (it's a
 * platform-wide catalog), so the gate would short-circuit before
 * consulting the frame — the wrap is the belt-and-braces defense in
 * case a future read here touches a scoped model (e.g. joining against
 * an issuance count). Same reasoning as the PlansController wrap landed
 * under TS-020-followup-2b-platform-rollout's service-subscription
 * sibling. Every other handler in this controller sits behind
 * `AccessTokenGuard` (`getMyProfile`, `listMyCertifications`) or
 * `AccessTokenGuard + PermissionGuard` (the five admin endpoints), so
 * the interceptor seeds a scoped frame from the access-token claims.
 */
@Controller()
export class CertificationsController {
  constructor(
    private readonly catalog: CertificationsCatalogService,
    private readonly providerCerts: ProviderCertificationsService,
    private readonly tier: TierPromotionService,
    private readonly prisma: PrismaService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Public catalog
  // ───────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/certifications — public catalog list.
   */
  @Get('api/v1/certifications')
  @HttpCode(HttpStatus.OK)
  async listCatalog(): Promise<CertificationsListResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-certifications-list', async () => {
      const rows = await this.catalog.listActive();
      const response: CertificationsListResponse = {
        certifications: rows.map(toCatalogDto),
      };
      return CertificationsListResponseSchema.parse(response);
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Provider self-view
  // ───────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/providers/me/profile — provider self-view with active certs.
   */
  @Get('api/v1/providers/me/profile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMyProfile(@Req() request: RequestWithContext): Promise<ProviderProfileResponse> {
    const userId = requireUserId(request);
    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
    })) as ProviderProfileRow | null;

    if (provider === null) {
      const empty: ProviderProfileResponse = {
        provider: null,
        activeCertifications: [],
      };
      return ProviderProfileResponseSchema.parse(empty);
    }

    const active = await this.providerCerts.listForProvider(provider.id, {
      activeOnly: true,
    });

    const response: ProviderProfileResponse = {
      provider: toProviderDto(provider),
      activeCertifications: active.map((record) => toProviderCertDto(record)),
    };
    return ProviderProfileResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/providers/me/certifications — provider's own cert log.
   */
  @Get('api/v1/providers/me/certifications')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMyCertifications(
    @Req() request: RequestWithContext,
  ): Promise<ProviderCertificationsListResponse> {
    const userId = requireUserId(request);
    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
      select: { id: true },
    })) as { id: string } | null;

    if (provider === null) {
      return ProviderCertificationsListResponseSchema.parse({ certifications: [] });
    }

    const records = await this.providerCerts.listForProvider(provider.id);
    const response: ProviderCertificationsListResponse = {
      certifications: records.map((record) => toProviderCertDto(record)),
    };
    return ProviderCertificationsListResponseSchema.parse(response);
  }

  // ───────────────────────────────────────────────────────────────────
  // Admin endpoints
  // ───────────────────────────────────────────────────────────────────

  /**
   * POST /api/v1/admin/providers/:providerId/certifications — grant.
   */
  @Post('api/v1/admin/providers/:providerId/certifications')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:approve')
  @Idempotent()
  async grantCertification(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(GrantProviderCertificationRequestSchema))
    body: GrantProviderCertificationRequest,
    @Req() request: RequestWithContext,
  ): Promise<ProviderCertificationResponse> {
    const actorId = requireUserId(request);

    const issuedAt = body.issuedAt !== undefined ? new Date(body.issuedAt) : undefined;
    // expiresAt: undefined → use catalog default; null → no expiry;
    // Date → explicit override. We must preserve null vs undefined.
    let expiresAt: Date | null | undefined = undefined;
    if (body.expiresAt === null) {
      expiresAt = null;
    } else if (body.expiresAt !== undefined) {
      expiresAt = new Date(body.expiresAt);
    }

    const result = await this.providerCerts.grant({
      providerId,
      certificationCode: body.certificationCode,
      ...(issuedAt !== undefined && { issuedAt }),
      ...(expiresAt !== undefined && { expiresAt }),
      issuerUserId: actorId,
      audit: buildAuditActorContext(requireContext(request), request),
      ...(body.notes !== undefined && { notes: body.notes }),
    });

    if (!result.ok) {
      throwProviderCertificationsFailure(result.error);
    }

    const response: ProviderCertificationResponse = {
      certification: toProviderCertDto(result.value),
    };
    return ProviderCertificationResponseSchema.parse(response);
  }

  /**
   * DELETE /api/v1/admin/providers/:providerId/certifications/:certId — revoke.
   */
  @Delete('api/v1/admin/providers/:providerId/certifications/:certId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:approve')
  @Idempotent()
  async revokeCertification(
    @Param('providerId') providerId: string,
    @Param('certId') certId: string,
    @Body(new ZodValidationPipe(RevokeProviderCertificationRequestSchema))
    body: RevokeProviderCertificationRequest,
    @Req() request: RequestWithContext,
  ): Promise<ProviderCertificationResponse> {
    const actorId = requireUserId(request);

    const result = await this.providerCerts.revoke({
      providerCertificationId: certId,
      providerId,
      revokerUserId: actorId,
      reason: body.reason,
      audit: buildAuditActorContext(requireContext(request), request),
    });

    if (!result.ok) {
      throwProviderCertificationsFailure(result.error);
    }

    const response: ProviderCertificationResponse = {
      certification: toProviderCertDto(result.value),
    };
    return ProviderCertificationResponseSchema.parse(response);
  }

  /**
   * POST /api/v1/admin/providers/:providerId/tier/evaluate — re-evaluate tier.
   */
  @Post('api/v1/admin/providers/:providerId/tier/evaluate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:approve')
  @Idempotent()
  async evaluateTier(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<TierEvaluationResponse> {
    const actorId = requireUserId(request);

    const result = await this.tier.evaluateAndApply({
      providerId,
      triggeredByUserId: actorId,
      audit: buildAuditActorContext(requireContext(request), request),
    });
    if (!result.ok) {
      throwTierFailure(result.error);
    }

    const provider = await this.loadFullProvider(providerId);
    if (provider === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    }

    const response: TierEvaluationResponse = {
      provider: toProviderDto(provider),
      previousTier: result.value.previousTier,
      nextTier: result.value.nextTier,
      applied: result.value.applied,
      history: result.value.history !== null ? toHistoryDto(result.value.history) : null,
    };
    return TierEvaluationResponseSchema.parse(response);
  }

  /**
   * POST /api/v1/admin/providers/:providerId/tier/override — manual override.
   */
  @Post('api/v1/admin/providers/:providerId/tier/override')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:approve')
  @Idempotent()
  async overrideTier(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(TierOverrideRequestSchema)) body: TierOverrideRequest,
    @Req() request: RequestWithContext,
  ): Promise<TierEvaluationResponse> {
    const actorId = requireUserId(request);

    const result = await this.tier.overrideTier({
      providerId,
      targetTier: body.targetTier,
      triggeredByUserId: actorId,
      notes: body.notes,
      audit: buildAuditActorContext(requireContext(request), request),
    });
    if (!result.ok) {
      throwTierFailure(result.error);
    }

    const provider = await this.loadFullProvider(providerId);
    if (provider === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    }

    const response: TierEvaluationResponse = {
      provider: toProviderDto(provider),
      previousTier: result.value.previousTier,
      nextTier: result.value.nextTier,
      applied: result.value.applied,
      history: result.value.history !== null ? toHistoryDto(result.value.history) : null,
    };
    return TierEvaluationResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/admin/providers/:providerId/tier/history — transition log.
   */
  @Get('api/v1/admin/providers/:providerId/tier/history')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:approve')
  async getTierHistory(
    @Param('providerId') providerId: string,
  ): Promise<ProviderTierHistoryResponse> {
    const history = await this.tier.getHistory(providerId);
    const response: ProviderTierHistoryResponse = {
      history: history.map(toHistoryDto),
    };
    return ProviderTierHistoryResponseSchema.parse(response);
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────

  private async loadFullProvider(providerId: string): Promise<ProviderProfileRow | null> {
    return (await this.prisma.provider.findUnique({
      where: { id: providerId },
    })) as ProviderProfileRow | null;
  }
}

interface ProviderProfileRow {
  readonly id: string;
  readonly status: 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
  readonly tier: 'basic' | 'certified' | 'elite';
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toCatalogDto(row: CertificationCatalogRecord): Certification {
  return CertificationSchema.parse({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    issuer: row.issuer,
    defaultValidityMonths: row.defaultValidityMonths,
    sortPosition: row.sortPosition,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toProviderDto(row: ProviderProfileRow): {
  readonly id: string;
  readonly status: ProviderProfileRow['status'];
  readonly tier: ProviderProfileRow['tier'];
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    profilePhotoKey: row.profilePhotoKey,
    videoIntroKey: row.videoIntroKey,
    timeZone: row.timeZone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The verified request context, or 401. `requireUserId` narrows to the id;
 * the audit emitter needs the whole context (role + tenant scope), and both
 * must come from the same verified source — never from a body.
 */
function requireContext(
  request: RequestWithContext,
): NonNullable<RequestWithContext['requestContext']> {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

/**
 * Map a `ProviderCertificationsFailure` to the matching HTTP
 * exception. Used by both grant + revoke.
 */
function throwProviderCertificationsFailure(failure: ProviderCertificationsFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'provider_not_found':
    case 'not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail:
          failure.reason === 'provider_not_found'
            ? 'Provider not found.'
            : 'Certification record not found.',
      });
    case 'certification_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Certification code not found: ${failure.certificationCode}.`,
      });
    case 'already_active':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Certification already active: ${failure.providerCertificationId}.`,
      });
    case 'already_revoked':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Certification already revoked: ${failure.providerCertificationId}.`,
      });
    case 'outbox_validation_failed':
      // TS-052-followup-1 — the producer-side outbox SDK rejected the
      // event payload against its registered Zod schema. This is a
      // bug at the platform layer (mismatched DTO vs. event-schema
      // shape), not a client error — surface as 500. The transaction
      // rolled back, so no state changed.
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: failure.message,
      });
  }
}

/**
 * Map a `TierPromotionFailure` to the matching HTTP exception.
 */
function throwTierFailure(failure: TierPromotionFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'provider_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    case 'outbox_validation_failed':
      // TS-052-followup-1 — same rationale as the certifications
      // mapper above. Tier-history payload failed event-schema
      // validation; tx rolled back; surface as 500.
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: failure.message,
      });
  }
}

// Re-export shapes for the test file's typed test data.
export type { ProviderProfileRow };
