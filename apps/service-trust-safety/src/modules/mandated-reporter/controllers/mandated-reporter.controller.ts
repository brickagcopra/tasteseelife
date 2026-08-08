import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { hasPermission, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  AdvanceMandatedReporterCaseRequestSchema,
  ListMandatedReporterCasesQuerySchema,
  MandatedReporterCaseListResponseSchema,
  MandatedReporterCaseResponseSchema,
  OpenMandatedReporterCaseRequestSchema,
  type AdvanceMandatedReporterCaseRequest,
  type ListMandatedReporterCasesQuery,
  type MandatedReporterCaseListResponse,
  type MandatedReporterCaseResponse,
  type OpenMandatedReporterCaseRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import type {
  MandatedReporterCaseRow,
  MandatedReporterCaseSummaryRow,
} from '../repositories/mandated-reporter.repository';
import { MandatedReporterService } from '../services/mandated-reporter.service';

/** The permission that authorises the mandated-reporter workflow. */
export const TRUST_SAFETY_WRITE_PERMISSION = 'trust_safety:write';

/**
 * Mandated-reporter ops surface (TS-303b; PRD §10.14, §11.4; PDD §16.1,
 * §16.4; CLAUDE.md §12).
 *
 *   POST /api/v1/admin/trust-safety/mandated-reporter/cases
 *     Route an incident into the statutory pathway. 201. Idempotent twice
 *     over: `@Idempotent()` on the header, and `incident_id` UNIQUE
 *     underneath — a retry returns the existing case rather than starting a
 *     second statutory clock on the same facts.
 *
 *   POST /api/v1/admin/trust-safety/mandated-reporter/cases/{caseId}/transitions
 *     Advance a case (filing prep / filed / not reportable / signed off). 200.
 *
 *   GET  /api/v1/admin/trust-safety/mandated-reporter/cases
 *     The operator queue (TS-303c2a). Filters on `status` / `stateCode`,
 *     bounded `limit`. Returns SUMMARY rows — no `determinationNotes` /
 *     `reviewerNotes`, because a list does not need a named senior's abuse
 *     narrative and a hundred of them in one payload is a PHI surface for
 *     nothing (CLAUDE.md §3.9). The detail read below carries them.
 *
 *   GET  /api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/{incidentId}
 *     The case for an incident, or 404 when triage never routed it here.
 *
 * **Ops-only, and re-checked here.** The gateway proxy applies
 * `@RequirePermissions('trust_safety:write')`; this handler re-checks the same
 * permission against the verified request context — the downstream service
 * never trusts the edge to have gated it (the `admin-concierge-*` /
 * TS-301b pattern).
 *
 * **Why a POST /transitions sub-resource rather than PATCH on the case.**
 * A transition is an event with its own payload (a filing reference, a
 * reviewer note) and its own legality rules, not a field assignment. Modelling
 * it as a sub-resource keeps the case row free of a partial-update surface
 * through which someone could set `status: 'signed_off'` directly and walk
 * past the four-eyes rule — the only way to reach a status is through the
 * transition endpoint, which checks it (CLAUDE.md §5.1, no `?action=`
 * overloading).
 */
@Controller()
export class MandatedReporterController {
  constructor(private readonly cases: MandatedReporterService) {}

  @Post('api/v1/admin/trust-safety/mandated-reporter/cases')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async open(
    @Body(new ZodValidationPipe(OpenMandatedReporterCaseRequestSchema))
    body: OpenMandatedReporterCaseRequest,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const opened = await this.cases.openCase({
      incidentId: body.incidentId,
      stateCode: body.stateCode,
      // The operator who classified it, from the verified token — never the
      // body (CLAUDE.md §3.2). This id is half of the four-eyes rule, so a
      // body-supplied value would let one person be both opener and reviewer.
      openedByUserId: ctx.userId,
      ...(body.determinationNotes !== undefined && {
        determinationNotes: body.determinationNotes,
      }),
      audit: buildAuditActorContext(ctx, request),
    });

    return toResponse(opened);
  }

  @Post('api/v1/admin/trust-safety/mandated-reporter/cases/:caseId/transitions')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async advance(
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(AdvanceMandatedReporterCaseRequestSchema))
    body: AdvanceMandatedReporterCaseRequest,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const advanced = await this.cases.advance({
      caseId,
      to: body.to,
      actorUserId: ctx.userId,
      ...(body.determinationNotes !== undefined && {
        determinationNotes: body.determinationNotes,
      }),
      ...(body.filingReference !== undefined && { filingReference: body.filingReference }),
      ...(body.reviewerNotes !== undefined && { reviewerNotes: body.reviewerNotes }),
      audit: buildAuditActorContext(ctx, request),
    });

    return toResponse(advanced);
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/cases')
  @UseGuards(AccessTokenGuard)
  async list(
    @Query(new ZodValidationPipe(ListMandatedReporterCasesQuerySchema))
    query: ListMandatedReporterCasesQuery,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseListResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const cases = await this.cases.listCases({
      status: query.status,
      stateCode: query.stateCode,
      limit: query.limit,
    });

    return MandatedReporterCaseListResponseSchema.parse({
      cases: cases.map(toSummary),
    });
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/:incidentId')
  @UseGuards(AccessTokenGuard)
  async getByIncident(
    @Param('incidentId') incidentId: string,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const found = await this.cases.getCaseForIncident(incidentId);
    if (found === null) {
      // 404 rather than a null body: "no case" and "no such incident" are the
      // same answer to the only question this route asks, and a caller that
      // must distinguish them reads the incident.
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'no mandated-reporter case exists for that incident',
      });
    }
    return toResponse(found);
  }
}

function toResponse(row: MandatedReporterCaseRow): MandatedReporterCaseResponse {
  return MandatedReporterCaseResponseSchema.parse({
    case: {
      id: row.id,
      incidentId: row.incidentId,
      stateCode: row.stateCode,
      status: row.status,
      openedByUserId: row.openedByUserId,
      openedAt: row.openedAt.toISOString(),
      statutoryDueAt: row.statutoryDueAt?.toISOString() ?? null,
      filedAt: row.filedAt?.toISOString() ?? null,
      filingReference: row.filingReference,
      determinationNotes: row.determinationNotes,
      reviewerUserId: row.reviewerUserId,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewerNotes: row.reviewerNotes,
    },
  });
}

/**
 * Queue-row mapper (TS-303c2a). Nothing to strip — the repository's projection
 * never fetched `determinationNotes` / `reviewerNotes`, and the row type does
 * not carry them, so a future edit that tried to leak them here would not
 * type-check.
 */
function toSummary(row: MandatedReporterCaseSummaryRow): Record<string, unknown> {
  return {
    id: row.id,
    incidentId: row.incidentId,
    stateCode: row.stateCode,
    status: row.status,
    openedByUserId: row.openedByUserId,
    openedAt: row.openedAt.toISOString(),
    statutoryDueAt: row.statutoryDueAt?.toISOString() ?? null,
    filedAt: row.filedAt?.toISOString() ?? null,
    filingReference: row.filingReference,
    reviewerUserId: row.reviewerUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
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
      detail: 'The mandated-reporter workflow requires the trust_safety:write permission.',
    });
  }
}
