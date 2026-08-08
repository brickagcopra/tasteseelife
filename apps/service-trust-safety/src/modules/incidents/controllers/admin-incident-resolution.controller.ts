import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { hasPermission, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  ResolveIncidentRequestSchema,
  ResolveIncidentResponseSchema,
  type ResolveIncidentRequest,
  type ResolveIncidentResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { TRUST_SAFETY_WRITE_PERMISSION } from '../../mandated-reporter/controllers/mandated-reporter.controller';
import { IncidentsService } from '../services/incidents.service';

/**
 * Incident resolution (TS-303b; CLAUDE.md §12).
 *
 *   POST /api/v1/admin/trust-safety/incidents/{incidentId}/resolution
 *     Close an incident. 200.
 *
 * **This route is what makes the never-auto-close rule real.** Until now
 * nothing in the platform could set an incident to `resolved` — TS-303a's
 * `assertIncidentResolvable` gate had nothing to gate. `IncidentsService`
 * calls it first, before any write, so an incident whose mandated-reporter
 * case has not been signed off returns 409 and stays open.
 *
 * Modelled as a `resolution` sub-resource rather than a PATCH on the incident:
 * closing is an event with a required narrative and a precondition, not a
 * field assignment, and there is deliberately no general incident-mutation
 * endpoint through which the status could be set past the gate.
 *
 * `@Idempotent()` collapses a double-submit; the underlying update is also a
 * compare-and-swap that excludes already-resolved rows, so a retry after the
 * idempotency window still cannot overwrite the first resolution's notes.
 */
@Controller()
export class AdminIncidentResolutionController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post('api/v1/admin/trust-safety/incidents/:incidentId/resolution')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async resolve(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(ResolveIncidentRequestSchema)) body: ResolveIncidentRequest,
    @Req() request: RequestWithContext,
  ): Promise<ResolveIncidentResponse> {
    const ctx = requireContext(request);
    requireTrustSafetyWrite(ctx);

    const resolved = await this.incidents.resolveIncident({
      incidentId,
      resolutionNotes: body.resolutionNotes,
      audit: buildAuditActorContext(ctx, request),
    });

    return ResolveIncidentResponseSchema.parse({
      incidentId: resolved.id,
      status: 'resolved',
      resolvedAt: (resolved.resolvedAt ?? new Date()).toISOString(),
    });
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

function requireTrustSafetyWrite(ctx: RequestContext): void {
  if (!hasPermission(ctx, TRUST_SAFETY_WRITE_PERMISSION)) {
    throw new ForbiddenException({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Resolving a trust & safety incident requires the trust_safety:write permission.',
    });
  }
}
