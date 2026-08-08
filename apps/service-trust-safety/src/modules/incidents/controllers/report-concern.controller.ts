import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  HOUSEHOLD_SCOPE_HEADER,
  ReportConcernRequestSchema,
  ReportConcernResponseSchema,
  type ReportConcernRequest,
  type ReportConcernResponse,
  type TrustSafetyIncidentCategory,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import type { IncidentSeverity, IncidentSource } from '../incident-enums';
import { IncidentsService } from '../services/incidents.service';

/**
 * Trust & Safety incident-intake HTTP boundary (TS-301a; PRD §10.14;
 * PDD §16.1).
 *
 *   POST /api/v1/trust-safety/incidents
 *     File a concern ("Report a concern"). The household is resolved from
 *     the token's `tenantScope: {type:'household', householdId}` claim — no
 *     household id crosses the wire (the token is the household-membership
 *     trust boundary; service-trust-safety cannot read
 *     `household.household_members`, CLAUDE.md §2.3 — the same posture as
 *     the TS-225 emergency channel). 201 + a minimal receipt.
 *
 * **Two filer shapes on one route (TS-301b).** The route admits exactly two
 * token shapes and derives everything from the token — nothing identifying
 * ever crosses the wire in the body:
 *
 *   - `tenantScope: household` → a family/senior filer. `householdId` comes
 *     off the scope claim (the token is the household-membership trust
 *     boundary; service-trust-safety cannot read
 *     `household.household_members`, CLAUDE.md §2.3). `source` is `senior`
 *     when the actor holds a `senior_user` assignment, else `family`.
 *   - `tenantScope: global` + a `provider` role → a provider filer.
 *     `source: 'provider'`, and the incident carries NO household.
 *
 * Any other shape (a partner tenant token, a global token with no provider
 * role) gets a 400 rather than a silent mis-file.
 *
 * **Why a provider report has no `providerId`.** A provider's token carries
 * `tenantScope: global` and there is no `providerId` claim anywhere in the
 * auth contract (`packages/auth-sdk/src/scope.ts`), and this service cannot
 * read service-provider's tables (§2.3). Letting web-provider self-assert a
 * `providerId` in the body was considered and REJECTED: on a trust & safety
 * surface that lets any provider pin a concern on a different provider. The
 * row instead anchors on `reporterUserId` — the verified token subject — and
 * provider linkage is resolved at triage (TS-301b-followup-1).
 *
 * **Severity default at intake.** The filer is never asked to grade their
 * own concern (a frightened family member should not be triaging). Intake
 * assigns a category-based default — welfare / safety → `high`,
 * billing / conduct → `medium` — and the TS-302 triage flow re-grades under
 * audit. The default errs high on the welfare/safety side deliberately
 * (CLAUDE.md §12: welfare concerns are first-class; better an early SLA
 * than a silent queue).
 *
 * Idempotency. `@Idempotent()` — a retried submit (or an anxious
 * double-tap) with the same `Idempotency-Key` returns the cached receipt
 * rather than opening two incidents (CLAUDE.md §3.3 / §17.5).
 */
@Controller()
export class ReportConcernController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post('api/v1/trust-safety/incidents')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(ReportConcernRequestSchema))
  @Idempotent()
  async report(
    @Body() body: ReportConcernRequest,
    @Req() request: RequestWithContext,
  ): Promise<ReportConcernResponse> {
    const ctx = requireContext(request);
    const filer = requireFilerScope(ctx);

    const incident = await this.incidents.createIncident({
      source: filer.source,
      category: body.category,
      severity: DEFAULT_SEVERITY_BY_CATEGORY[body.category],
      ...(filer.householdId !== null && { householdId: filer.householdId }),
      ...(body.seniorId !== undefined && { seniorId: body.seniorId }),
      // Always the verified token subject — never a body field.
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
    // Defence-in-depth: validate the response shape at the boundary so a
    // future drift between the row projection + contract surfaces here
    // rather than at the consumer — and the strict receipt schema keeps
    // internal triage fields from ever leaking to the filer.
    return ReportConcernResponseSchema.parse(response);
  }
}

/**
 * Category → intake-default severity. See the controller doc-block: the
 * filer never grades their own concern; TS-302 triage re-grades under audit.
 */
export const DEFAULT_SEVERITY_BY_CATEGORY: Readonly<
  Record<TrustSafetyIncidentCategory, IncidentSeverity>
> = {
  welfare: 'high',
  safety: 'high',
  billing: 'medium',
  conduct: 'medium',
};

/**
 * `senior` when the actor holds a `senior_user` assignment, else `family` —
 * see the controller doc-block. Household-scoped actors only; the provider
 * branch never reaches this.
 */
export function deriveSource(ctx: RequestContext): IncidentSource {
  return ctx.roles.some((role) => role.name === 'senior_user') ? 'senior' : 'family';
}

/** The role assignment that marks a token as a provider's. */
const PROVIDER_ROLE_NAME = 'provider';

/** Resolved filer identity — what the token says this actor is filing as. */
export interface FilerScope {
  readonly source: IncidentSource;
  /** `null` on the provider path: a provider report concerns no household. */
  readonly householdId: string | null;
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

/**
 * Resolve who the actor is filing as, from the token alone — see the
 * controller doc-block for the two admitted shapes.
 *
 * A partner (tenant scope) token, or a global token with no `provider` role,
 * has no "my household" and no provider identity to file against, so it gets
 * a 400 rather than a silent mis-file. Note the concierge on-behalf path is
 * NOT here: a body-supplied household id is an authorisation decision, so it
 * lives on its own `concierge:write`-gated route
 * (`AdminReportConcernController`) rather than as a branch of this one.
 */
export function requireFilerScope(ctx: RequestContext): FilerScope {
  if (ctx.tenantScope.type === 'household') {
    return { source: deriveSource(ctx), householdId: ctx.tenantScope.householdId };
  }

  if (
    ctx.tenantScope.type === 'global' &&
    ctx.roles.some((role) => role.name === PROVIDER_ROLE_NAME)
  ) {
    return { source: 'provider', householdId: null };
  }

  throw new BadRequestException({
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail:
      `This endpoint is only available to household members and providers. If you ` +
      `belong to more than one household, name the one you are acting in with the ` +
      `${HOUSEHOLD_SCOPE_HEADER} header.`,
  });
}
