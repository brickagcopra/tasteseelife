import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  CreateDataSubjectRequestSchema,
  DataSubjectRequestListResponseSchema,
  DataSubjectRequestReceiptResponseSchema,
  type CreateDataSubjectRequest,
  type DataSubjectRequestListResponse,
  type DataSubjectRequestReceiptResponse,
} from '@taste-and-see/contracts';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toReceipt } from '../mappers/data-subject-request.mapper';
import { DataSubjectRequestsService } from '../services/data-subject-requests.service';

/**
 * The requester-facing Privacy Center API (TS-309a; PRD §11.4; PDD §16.3).
 *
 *   POST /api/v1/privacy/requests              — file a request
 *   GET  /api/v1/privacy/requests              — my requests
 *   GET  /api/v1/privacy/requests/:id          — one of mine
 *   POST /api/v1/privacy/requests/:id/withdraw — withdraw my own
 *
 * **No permission gate — the gate is being the requester.** These routes are
 * for any authenticated user exercising a statutory right about themselves;
 * requiring an RBAC permission would mean the platform granting people
 * permission to ask what it holds about them, which is the wrong shape.
 * Every route is scoped to `requestContext.userId` instead, and reading or
 * withdrawing someone else's request 404s rather than 403s: on a privacy
 * surface, confirming that a given request exists is itself a disclosure.
 *
 * **Filing requires an MFA-verified session.** A self-service request is
 * verified BY that session — it is the strongest proof this service has that
 * a caller is the account holder — so the proof has to be worth something. A
 * password-only session filing a self-service access request would let a
 * stolen cookie start a lawful-looking export of everything the platform
 * holds about its owner (CLAUDE.md §3.1). Reads are not gated the same way:
 * a receipt carries no personal data beyond the fact that you asked.
 *
 * Both writes wear `@Idempotent()` — a retried "file" must not open a second
 * statutory clock on the same question (CLAUDE.md §3.3).
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class PrivacyRequestsController {
  constructor(private readonly requests: DataSubjectRequestsService) {}

  @Post('api/v1/privacy/requests')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateDataSubjectRequestSchema))
  @Idempotent()
  async file(
    @Body() body: CreateDataSubjectRequest,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireMfaVerifiedContext(request);
    const row = await this.requests.createRequest(
      {
        // Stamped from the VERIFIED token. The contract has no
        // `requesterUserId` field at all, so this cannot be overridden.
        requesterUserId: ctx.userId,
        kind: body.kind,
        ...(body.subjectKind !== undefined ? { subjectKind: body.subjectKind } : {}),
        ...(body.subjectId !== undefined ? { subjectId: body.subjectId } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
      buildAuditActorContext(ctx, request),
    );
    return DataSubjectRequestReceiptResponseSchema.parse({ request: toReceipt(row) });
  }

  @Get('api/v1/privacy/requests')
  async listMine(@Req() request: RequestWithContext): Promise<DataSubjectRequestListResponse> {
    const ctx = requireContext(request);
    const rows = await this.requests.listForRequester(ctx.userId);
    return DataSubjectRequestListResponseSchema.parse({ requests: rows.map(toReceipt) });
  }

  @Get('api/v1/privacy/requests/:id')
  async getMine(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireContext(request);
    const row = await this.requests.getForRequester(id, ctx.userId);
    return DataSubjectRequestReceiptResponseSchema.parse({ request: toReceipt(row) });
  }

  /**
   * Withdraw. The requester's act and nobody else's — an operator who thinks a
   * request should not proceed REFUSES it, with a categorical reason, on the
   * record. The service enforces the ownership rule as well, because it is a
   * domain rule rather than a routing detail.
   */
  @Post('api/v1/privacy/requests/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async withdraw(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireContext(request);
    const row = await this.requests.withdraw(id, ctx.userId, buildAuditActorContext(ctx, request));
    return DataSubjectRequestReceiptResponseSchema.parse({ request: toReceipt(row) });
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

/**
 * Filing requires a second factor.
 *
 * 403 rather than 401 because the session IS valid — it is simply not strong
 * enough to be the verification a self-service request rests on. The `code`
 * lets a client route the user to step-up rather than to a login screen
 * (RFC 7807 + the `code` convention TS-296 introduced).
 */
function requireMfaVerifiedContext(
  request: RequestWithContext,
): NonNullable<RequestWithContext['requestContext']> {
  const ctx = requireContext(request);
  if (!ctx.mfaVerified) {
    throw new ForbiddenException({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'mfa_required',
      detail: 'Filing a privacy request requires a fully verified session.',
    });
  }
  return ctx;
}
