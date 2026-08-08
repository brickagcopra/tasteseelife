import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { hasPermission, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  AdminReportConcernRequestSchema,
  ReportConcernResponseSchema,
  type AdminReportConcernRequest,
  type ReportConcernResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { IncidentsService } from '../services/incidents.service';
import { DEFAULT_SEVERITY_BY_CATEGORY } from './report-concern.controller';

/** The permission that authorises filing on another household's behalf. */
export const CONCIERGE_WRITE_PERMISSION = 'concierge:write';

/**
 * Concierge on-behalf incident intake (TS-301b; PRD §10.14; PDD §16.1).
 *
 *   POST /api/v1/admin/trust-safety/incidents
 *     A concierge files a concern FOR a household — the household id comes
 *     from the request body. 201 + the same minimal receipt as the
 *     filer-facing route.
 *
 * **Why this is a separate route from `POST /api/v1/trust-safety/incidents`.**
 * On the filer-facing route the household is derived from the token scope and
 * a body-supplied household is rejected outright — that asymmetry IS the
 * trust boundary. Accepting a body household id is therefore an
 * authorisation decision, not a validation one, and it has to be gated by a
 * permission. A single shared route could not do that: the gateway's
 * `PermissionGuard` decides per-route, so gating one shared route on
 * `concierge:write` would lock families out, and NOT gating it would push the
 * decision down into a body-shape sniff. Splitting the route keeps the gate
 * declarative and keeps the family path's "no household on the wire"
 * invariant literally true.
 *
 * (This deviates from the TS-301b task text, which read "both POST through
 * the TS-301a proxy". Recorded in `Completed_tasks.md`.)
 *
 * **Defence in depth.** The gateway proxy applies
 * `@RequirePermissions('concierge:write')`, and this handler re-checks the
 * same permission against the verified request context — the pattern the
 * `admin-concierge-*` proxies document (the downstream service never trusts
 * the edge to have gated it).
 *
 * Severity default and idempotency match the filer-facing route: intake never
 * asks anyone to grade a concern, and `@Idempotent()` collapses a retried
 * submit onto one incident.
 */
@Controller()
export class AdminReportConcernController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post('api/v1/admin/trust-safety/incidents')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(AdminReportConcernRequestSchema))
  @Idempotent()
  async reportOnBehalf(
    @Body() body: AdminReportConcernRequest,
    @Req() request: RequestWithContext,
  ): Promise<ReportConcernResponse> {
    const ctx = requireContext(request);
    requireConciergeWrite(ctx);

    const incident = await this.incidents.createIncident({
      source: 'concierge',
      category: body.category,
      severity: DEFAULT_SEVERITY_BY_CATEGORY[body.category],
      // The one path where the household comes off the body — authorised
      // above, and only here.
      householdId: body.householdId,
      ...(body.seniorId !== undefined && { seniorId: body.seniorId }),
      // The concierge who filed it, not the household member it concerns.
      reporterUserId: ctx.userId,
      description: body.description,
    });

    const response: ReportConcernResponse = {
      receipt: {
        incidentId: incident.id,
        category: incident.category,
        openedAt: incident.openedAt.toISOString(),
      },
    };
    return ReportConcernResponseSchema.parse(response);
  }
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

function requireConciergeWrite(ctx: RequestContext): void {
  if (!hasPermission(ctx, CONCIERGE_WRITE_PERMISSION)) {
    throw new ForbiddenException({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Filing on behalf of a household requires the concierge:write permission.',
    });
  }
}
