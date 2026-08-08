import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminDataSubjectRequestListResponseSchema,
  DataSubjectRequestResponseSchema,
  ExtendDataSubjectRequestSchema,
  ListDataSubjectRequestsQuerySchema,
  RefuseDataSubjectRequestSchema,
  VerifyDataSubjectRequestSchema,
  type AdminDataSubjectRequestListResponse,
  type DataSubjectRequestResponse,
} from '@taste-and-see/contracts';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toRecord } from '../mappers/data-subject-request.mapper';
import { DataSubjectRequestsService } from '../services/data-subject-requests.service';

/**
 * Operator surface for data-subject requests (TS-309a; PRD §11.4; PDD §16.3,
 * §16.4; CLAUDE.md §3.2, §3.6).
 *
 *   GET  /api/v1/admin/privacy/requests             — the queue   (privacy:read)
 *   GET  /api/v1/admin/privacy/requests/:id         — one request (privacy:read)
 *   POST /api/v1/admin/privacy/requests/:id/verify  — verify      (privacy:write)
 *   POST /api/v1/admin/privacy/requests/:id/refuse  — refuse      (privacy:write)
 *   POST /api/v1/admin/privacy/requests/:id/extend  — extend      (privacy:write)
 *
 * **New permissions, so `pnpm seed:rbac` must re-run on deploy.** They are new
 * rather than reused because none of the existing ones fit: `rbac:*` is about
 * who may act on the platform, and gating a statutory request queue on it
 * would hand privacy decisions to whoever administers roles.
 *
 * **There is no `fulfil` route here, deliberately.** Fulfilment is what
 * TS-309b's export job does when the artefact actually exists — a button that
 * marks a request fulfilled without producing anything would let an operator
 * close a statutory obligation by asserting it was met. The three acts an
 * operator genuinely owns are verifying the requester, refusing with a
 * reason, and taking the one permitted extension.
 *
 * **`withdraw` is absent for the mirror reason**: it is the requester's act,
 * and an operator who thinks a request should not proceed refuses it, on the
 * record, with a categorical reason.
 *
 * Every mutation emits `audit.action_recorded` in the same transaction as the
 * state change — the actor is built from the VERIFIED token plus request
 * metadata, never from a body.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminPrivacyRequestsController {
  constructor(private readonly requests: DataSubjectRequestsService) {}

  @Get('api/v1/admin/privacy/requests')
  @RequirePermissions('privacy:read')
  async list(
    @Query(new ZodValidationPipe(ListDataSubjectRequestsQuerySchema))
    query: {
      status?: 'received' | 'verifying' | 'in_progress' | 'fulfilled' | 'refused' | 'withdrawn';
      kind?: 'access' | 'erasure';
      subjectKind?: 'user' | 'senior' | 'provider';
      limit: number;
    },
  ): Promise<AdminDataSubjectRequestListResponse> {
    const rows = await this.requests.listQueue({
      status: query.status,
      kind: query.kind,
      subjectKind: query.subjectKind,
      limit: query.limit,
    });
    return AdminDataSubjectRequestListResponseSchema.parse({ requests: rows.map(toRecord) });
  }

  @Get('api/v1/admin/privacy/requests/:id')
  @RequirePermissions('privacy:read')
  async get(@Param('id') id: string): Promise<DataSubjectRequestResponse> {
    const row = await this.requests.getById(id);
    return DataSubjectRequestResponseSchema.parse({ request: toRecord(row) });
  }

  /**
   * Record that the requester's link to the subject has been established.
   *
   * This is the act that lets a request about SOMEBODY ELSE proceed, which is
   * why the method is required and stored: an unexplained verification is not
   * one. Self-service requests are rejected here — they are already verified
   * by the session that filed them, and accepting one would let an operator
   * overwrite that trail with a weaker human-asserted claim.
   */
  @Post('api/v1/admin/privacy/requests/:id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  @Idempotent()
  async verify(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VerifyDataSubjectRequestSchema)) body: { method: string },
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    const ctx = requireContext(request);
    const row = await this.requests.verify(
      id,
      body.method,
      buildAuditActorContext(ctx, request),
      ctx.userId,
    );
    return DataSubjectRequestResponseSchema.parse({ request: toRecord(row) });
  }

  @Post('api/v1/admin/privacy/requests/:id/refuse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  @Idempotent()
  async refuse(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RefuseDataSubjectRequestSchema))
    body: {
      reason:
        | 'identity_not_verified'
        | 'not_the_subject'
        | 'subject_consent_absent'
        | 'retention_required'
        | 'duplicate_request'
        | 'out_of_scope';
      note?: string;
    },
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    const ctx = requireContext(request);
    const row = await this.requests.refuse(
      id,
      body.reason,
      body.note,
      buildAuditActorContext(ctx, request),
    );
    return DataSubjectRequestResponseSchema.parse({ request: toRecord(row) });
  }

  @Post('api/v1/admin/privacy/requests/:id/extend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  @Idempotent()
  async extend(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExtendDataSubjectRequestSchema)) body: { reason: string },
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    const ctx = requireContext(request);
    const row = await this.requests.extend(id, body.reason, buildAuditActorContext(ctx, request));
    return DataSubjectRequestResponseSchema.parse({ request: toRecord(row) });
  }
}

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
