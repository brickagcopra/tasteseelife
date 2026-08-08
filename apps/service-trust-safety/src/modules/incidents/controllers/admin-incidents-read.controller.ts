import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { hasPermission, type RequestContext } from '@taste-and-see/auth-sdk';
import {
  ListTrustSafetyIncidentsQuerySchema,
  TrustSafetyIncidentListResponseSchema,
  TrustSafetyIncidentDetectorSchema,
  TrustSafetyIncidentResponseSchema,
  TrustSafetySystemEvidenceSchema,
  type ListTrustSafetyIncidentsQuery,
  type TrustSafetyIncidentListResponse,
  type TrustSafetyIncidentResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import type { IncidentDetailRow, IncidentSummaryRow } from '../repositories/incident.repository';
import { IncidentsService } from '../services/incidents.service';

/**
 * Logger for the module-scope read helpers below. They are functions, not
 * methods, so they cannot reach the controller's injected logger — and the
 * one thing they log (a stored evidence blob that no longer parses) must
 * not be swallowed.
 */
const READ_LOGGER = new Logger('AdminIncidentsReadController');

/** The queue read. See the class doc-block for why this is the weaker gate. */
export const TRUST_SAFETY_READ_PERMISSION = 'trust_safety:read';
/** The detail read, because it carries free text about a named senior. */
export const TRUST_SAFETY_WRITE_PERMISSION = 'trust_safety:write';

/**
 * Operator incident reads (TS-303c2d; PRD §10.14; PDD §16.1; CLAUDE.md §12).
 *
 *   GET /api/v1/admin/trust-safety/incidents
 *     The operator queue. Filters on status / severity / category and on the
 *     three subject ids (household / senior / provider — the 360-view
 *     scrolls). SLA-ordered, soonest first. Returns SUMMARY rows.
 *
 *   GET /api/v1/admin/trust-safety/incidents/{incidentId}
 *     One incident, with the filer's `description`, the `resolutionNotes`,
 *     and whether a mandated-reporter case exists on it.
 *
 * **This is the service's first incident READ surface.** Until now
 * `IncidentsService.getIncident` was an internal seam and the only HTTP
 * routes were three intake POSTs plus the resolution POST — so the queue that
 * TS-300 cut `trust_safety_incidents_unresolved_sla_idx` for had no reader,
 * and an operator could not navigate from an incident to opening a
 * mandated-reporter case on it.
 *
 * **The two routes carry DIFFERENT permissions, and the split is the point.**
 * The queue is gated `trust_safety:read`; the detail is gated
 * `trust_safety:write`. That looks inverted until you look at what each
 * returns. The summary is categorical — kind, severity, SLA position, subject
 * ids — and someone triaging workload needs it. The detail carries
 * `description`: a family member's free-text account of what they believe
 * happened to a named senior, which is the most sensitive string the platform
 * holds. Gating the narrative on the stronger permission keeps a future
 * read-only ops role able to see the shape of the queue without being handed
 * the narratives, and it gives `trust_safety:read` its first real use (it has
 * existed in the catalog since TS-303c1 and gated nothing).
 *
 * Both permissions are checked here against the verified request context, not
 * merely at the gateway — the edge gate is never the only gate.
 */
@Controller()
export class AdminIncidentsReadController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get('api/v1/admin/trust-safety/incidents')
  @UseGuards(AccessTokenGuard)
  async list(
    @Query(new ZodValidationPipe(ListTrustSafetyIncidentsQuerySchema))
    query: ListTrustSafetyIncidentsQuery,
    @Req() request: RequestWithContext,
  ): Promise<TrustSafetyIncidentListResponse> {
    const ctx = requireContext(request);
    requirePermission(ctx, TRUST_SAFETY_READ_PERMISSION, 'The incident queue');

    const incidents = await this.incidents.listIncidents({
      status: query.status,
      severity: query.severity,
      category: query.category,
      householdId: query.householdId,
      seniorId: query.seniorId,
      providerId: query.providerId,
      limit: query.limit,
    });

    return TrustSafetyIncidentListResponseSchema.parse({
      incidents: incidents.map(toSummary),
    });
  }

  @Get('api/v1/admin/trust-safety/incidents/:incidentId')
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('incidentId') incidentId: string,
    @Req() request: RequestWithContext,
  ): Promise<TrustSafetyIncidentResponse> {
    const ctx = requireContext(request);
    requirePermission(ctx, TRUST_SAFETY_WRITE_PERMISSION, 'Reading an incident report');

    const incident = await this.incidents.getIncidentDetail(incidentId);
    return TrustSafetyIncidentResponseSchema.parse({ incident: toDetail(incident) });
  }
}

/**
 * Queue-row mapper. Nothing to strip — the repository projection never fetched
 * `description` / `resolutionNotes` and the row type does not carry them, so a
 * later edit that tried to leak them here would not type-check.
 */
function toSummary(row: IncidentSummaryRow): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    category: row.category,
    severity: row.severity,
    status: row.status,
    householdId: row.householdId,
    seniorId: row.seniorId,
    providerId: row.providerId,
    reporterUserId: row.reporterUserId,
    openedAt: row.openedAt.toISOString(),
    slaDueAt: row.slaDueAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    hasMandatedReporterCase: row.hasMandatedReporterCase,
  };
}

function toDetail(row: IncidentDetailRow): Record<string, unknown> {
  return {
    ...toSummary(row),
    description: row.description,
    resolutionNotes: row.resolutionNotes,
    sourceEventId: row.sourceEventId,
    detector: parseDetector(row.detector),
    systemEvidence: readSystemEvidence(row),
  };
}

/**
 * A stored detector name, narrowed to the contract's enum.
 *
 * The column is TEXT so a fourth detector needs no migration, which means
 * the read path is where an unrecognised value has to be handled. Null is
 * the honest answer: the console renders "opened by the system" without
 * claiming a detector it cannot name.
 */
function parseDetector(value: string | null): string | null {
  if (value === null) return null;
  const parsed = TrustSafetyIncidentDetectorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored evidence, narrowed to the contract union.
 *
 * **`safeParse`, and null on failure — never a throw.** What is in the
 * column is whatever some previous build wrote, and the contract will
 * evolve. Blowing up the detail read would lock an operator out of an
 * incident entirely over a field that is supplementary to it, which is a
 * strictly worse failure than the one this whole slice fixes. The
 * unparseable case is logged at error (it means a producer and this
 * schema have drifted) and the separately-stored `detector` still lets the
 * page say WHICH detector opened the incident.
 */
function readSystemEvidence(row: IncidentDetailRow): unknown {
  if (row.systemFacts === null || row.systemFacts === undefined) return null;
  const parsed = TrustSafetySystemEvidenceSchema.safeParse(row.systemFacts);
  if (parsed.success) return parsed.data;
  READ_LOGGER.error(
    `trust_safety.incident.system_evidence_unreadable ${JSON.stringify({
      incidentId: row.id,
      detector: row.detector,
      // Field paths and codes only — never the stored values, which is the
      // one thing this log line must not echo.
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    })}`,
  );
  return null;
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

function requirePermission(
  ctx: RequestContext,
  permission: `${string}:${string}`,
  subject: string,
): void {
  if (!hasPermission(ctx, permission)) {
    throw new ForbiddenException({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: `${subject} requires the ${permission} permission.`,
    });
  }
}
