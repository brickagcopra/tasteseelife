import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { hasPermission, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  MandatedReporterJurisdictionListResponseSchema,
  MandatedReporterJurisdictionResponseSchema,
  SetMandatedReporterJurisdictionVerificationRequestSchema,
  UpsertMandatedReporterJurisdictionRequestSchema,
  type MandatedReporterJurisdictionListResponse,
  type MandatedReporterJurisdictionResponse,
  type SetMandatedReporterJurisdictionVerificationRequest,
  type UpsertMandatedReporterJurisdictionRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import type { JurisdictionRow } from '../repositories/mandated-reporter.repository';
import { MandatedReporterService } from '../services/mandated-reporter.service';
import { TRUST_SAFETY_WRITE_PERMISSION } from './mandated-reporter.controller';

/**
 * Per-state mandated-reporter workflow kit (TS-303c1; PDD §16.4).
 *
 *   GET  /api/v1/admin/trust-safety/mandated-reporter/jurisdictions[?unverifiedOnly=true]
 *   GET  /api/v1/admin/trust-safety/mandated-reporter/jurisdictions/{stateCode}
 *   PUT  /api/v1/admin/trust-safety/mandated-reporter/jurisdictions/{stateCode}
 *   POST /api/v1/admin/trust-safety/mandated-reporter/jurisdictions/{stateCode}/verification
 *
 * **This is compliance's surface, and its content is legal reference data the
 * platform does not author.** The table shipped empty (TS-303a) precisely so
 * that no guessed hotline or deadline could ever be mistaken for a checked
 * one. Every row lands unverified, and until compliance attests to it the
 * mandated-reporter workflow refuses to prepare a filing in that state.
 *
 * Verification is a separate route from editing on purpose: it is an
 * attestation with its own attribution and its own audit action, and folding
 * it into the field update would let it ride along on an unrelated edit.
 * Conversely, editing a substantive field of a verified row CLEARS the
 * attestation — see `MandatedReporterService.upsertJurisdiction`.
 *
 * Gated on `trust_safety:write` at the gateway and re-checked here. The read
 * routes carry the same gate rather than a weaker `:read`: the kit is the
 * operating manual for an elder-abuse reporting workflow, and its audience is
 * exactly the people who run that workflow.
 */
@Controller()
export class MandatedReporterJurisdictionsController {
  constructor(private readonly cases: MandatedReporterService) {}

  @Get('api/v1/admin/trust-safety/mandated-reporter/jurisdictions')
  @UseGuards(AccessTokenGuard)
  async list(
    @Query('unverifiedOnly') unverifiedOnly: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionListResponse> {
    requireTrustSafetyWrite(requireContext(request));

    const rows = await this.cases.listJurisdictions(unverifiedOnly === 'true');
    return MandatedReporterJurisdictionListResponseSchema.parse({
      jurisdictions: rows.map(toRecord),
    });
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode')
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('stateCode') stateCode: string,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    requireTrustSafetyWrite(requireContext(request));

    const row = await this.cases.getJurisdiction(stateCode);
    return toResponse(row);
  }

  @Put('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async upsert(
    @Param('stateCode') stateCode: string,
    @Body(new ZodValidationPipe(UpsertMandatedReporterJurisdictionRequestSchema))
    body: UpsertMandatedReporterJurisdictionRequest,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const saved = await this.cases.upsertJurisdiction({
      stateCode,
      changes: body,
      audit: buildAuditActorContext(ctx, request),
    });
    return toResponse(saved);
  }

  @Post('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode/verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async setVerification(
    @Param('stateCode') stateCode: string,
    @Body(new ZodValidationPipe(SetMandatedReporterJurisdictionVerificationRequestSchema))
    body: SetMandatedReporterJurisdictionVerificationRequest,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const saved = await this.cases.setJurisdictionVerification({
      stateCode,
      verified: body.verified,
      ...(body.notes !== undefined && { notes: body.notes }),
      // The attesting actor comes from the verified token — this id is the
      // accountability record for a legal determination (CLAUDE.md §3.6).
      audit: buildAuditActorContext(ctx, request),
    });
    return toResponse(saved);
  }
}

function toRecord(row: JurisdictionRow): Record<string, unknown> {
  return {
    stateCode: row.stateCode,
    agencyName: row.agencyName,
    reportingPhone: row.reportingPhone,
    reportingUrl: row.reportingUrl,
    statutoryDeadlineHours: row.statutoryDeadlineHours,
    platformRole: row.platformRole,
    statuteCitation: row.statuteCitation,
    verified: row.verified,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
    notes: row.notes,
  };
}

function toResponse(row: JurisdictionRow): MandatedReporterJurisdictionResponse {
  return MandatedReporterJurisdictionResponseSchema.parse({ jurisdiction: toRecord(row) });
}

function requireContext(request: RequestWithContext): RequestContext {
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

function requireTrustSafetyWrite(ctx: RequestContext): void {
  if (!hasPermission(ctx, TRUST_SAFETY_WRITE_PERMISSION)) {
    throw new ForbiddenException({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'The mandated-reporter jurisdiction kit requires the trust_safety:write permission.',
    });
  }
}
