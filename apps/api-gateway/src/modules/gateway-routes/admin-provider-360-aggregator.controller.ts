import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  Provider360ResponseSchema,
  ProviderDossierResponseSchema,
  TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX,
  TrustSafetyIncidentListResponseSchema,
  type Provider360IncidentsSection,
  type Provider360IncidentsUnavailableReason,
  type Provider360Response,
  type ProviderDossierResponse,
  type TrustSafetyIncidentSummary,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Provider 360 BFF aggregator (TS-305b; PRD §10.14, PDD §16.1).
 *
 *   GET /api/v1/admin/providers/:providerId/360
 *     The review committee's composed view of one provider. Fans out
 *     to `service-provider`'s dossier (TS-305a) and
 *     `service-trust-safety`'s incident scroll (TS-303c2d).
 *
 * **Authorisation — `trust_safety:write` AND `provider:read`.** The
 * task specified the first; the second is what the page actually
 * reads. `@RequirePermissions` is AND-semantics, and requiring both at
 * the edge means a caller who is missing one gets a 403 naming the
 * permission rather than a page whose provider panel silently 502s.
 * Both downstreams re-check their own gate — the edge is never the
 * only gate. In the shipped seed catalog `trust_safety` and
 * `super_admin` hold all three of `trust_safety:read` / `:write` /
 * `provider:read`, so this is not a new grant requirement; it is an
 * accurate declaration of what the surface consumes.
 *
 * **The dossier is fatal; incidents degrade.** A committee can
 * deliberate on credentials and tier history while trust-safety is
 * down, but not on a page that silently omits a complaint history. So
 * a dossier failure fails the request (with the upstream's own status
 * for 404 / 4xx), while an incident failure fills the section with an
 * explicit `unavailable` state and a reason the UI must render.
 *
 * **Two incident calls, not one.** The incident queue's default
 * excludes `resolved` — it means live work. A complaint HISTORY must
 * include closed incidents, so this issues the live query and a
 * `?status=resolved` query and merges them. Making the downstream
 * query take an `includeResolved` flag would have been fewer round
 * trips at the cost of changing a shipped contract for one consumer;
 * two GETs against an indexed filter is the cheaper trade. If EITHER
 * call fails, the section is unavailable — a history missing its
 * resolved half is worse than one that admits it is missing.
 *
 * **Under-count caveat.** An incident FILED BY a provider carries a
 * null `provider_id` (TS-301b), so this scroll under-reports until
 * TS-301b-followup-1 lands. The response does not encode that — see
 * the contract's doc-block for why — and every consumer must state it
 * on screen (TS-305-note).
 *
 * **No idempotency key** — GET is naturally idempotent.
 */
@Controller('api/v1/admin/providers')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminProvider360AggregatorController {
  private readonly logger = new Logger(AdminProvider360AggregatorController.name);

  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':providerId/360')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('trust_safety:write', 'provider:read')
  async getProvider360(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<Provider360Response> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);
    const encodedId = encodeURIComponent(providerId);

    // Both upstreams are dispatched together — the incident section is
    // allowed to fail, so there is nothing to gain by waiting on the
    // dossier first, and a committee tool that takes two sequential
    // round-trips on every open is a tool people stop opening.
    const [dossierResult, incidentsSection] = await Promise.all([
      this.downstream.call({
        service: 'provider',
        path: `/api/v1/admin/providers/${encodedId}/dossier`,
        method: 'GET',
        actor: ctx,
        traceId,
      }),
      this.fetchIncidents(providerId, ctx, traceId),
    ]);

    const dossier = mapDossierResult(dossierResult, traceId);

    return Provider360ResponseSchema.parse({
      provider: dossier.provider,
      certifications: dossier.certifications,
      tierHistory: dossier.tierHistory,
      backgroundCheck: dossier.backgroundCheck,
      // TS-305d. Arrives INSIDE the dossier, which is the fatal
      // upstream, so it is passed straight through and is not a second
      // degradable section: if the dossier answered at all, the metrics
      // answered with it. Only `incidents` has an upstream of its own
      // and therefore a way to be `unavailable`.
      metrics: dossier.metrics,
      incidents: incidentsSection,
      // Gateway composition wall-clock — deliberately not the
      // dossier's own `generatedAt`, which predates the fan-out.
      generatedAt: new Date().toISOString(),
    } satisfies Provider360Response);
  }

  /**
   * Fetch the live + resolved incident scrolls for this provider and
   * merge them into the section shape. Never throws: every failure
   * becomes an `unavailable` state.
   */
  private async fetchIncidents(
    providerId: string,
    ctx: NonNullable<RequestWithContext['requestContext']>,
    traceId: string | undefined,
  ): Promise<Provider360IncidentsSection> {
    const query = (status?: string): string => {
      const search = new URLSearchParams();
      search.set('providerId', providerId);
      search.set('limit', String(TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX));
      if (status !== undefined) search.set('status', status);
      return `/api/v1/admin/trust-safety/incidents?${search.toString()}`;
    };

    const [liveResult, resolvedResult] = await Promise.all([
      this.downstream.call({
        service: 'trust-safety',
        path: query(),
        method: 'GET',
        actor: ctx,
        traceId,
      }),
      this.downstream.call({
        service: 'trust-safety',
        path: query('resolved'),
        method: 'GET',
        actor: ctx,
        traceId,
      }),
    ]);

    const live = readIncidentPage(liveResult);
    const resolved = readIncidentPage(resolvedResult);

    // Either half missing degrades the whole section: a complaint
    // history missing its resolved incidents is worse than one that
    // admits it is missing. Checked live-first so that when both fail
    // — they almost always share a cause — the rendered reason is
    // stable across retries rather than a race.
    if (live.kind === 'unavailable') {
      return this.degraded(providerId, live.reason, traceId);
    }
    if (resolved.kind === 'unavailable') {
      return this.degraded(providerId, resolved.reason, traceId);
    }

    // Dedupe by id before merging. The two queries are disjoint by
    // construction (one excludes `resolved`, the other selects only it),
    // but an incident resolved BETWEEN the two calls lands in both, and
    // a committee counting rows must not double-count it.
    const byId = new Map<string, TrustSafetyIncidentSummary>();
    for (const incident of [...live.incidents, ...resolved.incidents]) {
      byId.set(incident.id, incident);
    }

    // Newest-first. Not the queue's `slaDueAt` order: that queue asks
    // "what must I work next", this section asks "what has happened to
    // this provider".
    const incidents = [...byId.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt));

    return {
      state: 'available',
      incidents,
      truncated: live.truncated || resolved.truncated,
    };
  }

  /**
   * Build the degraded section and log it. WARN, not debug: a
   * committee looking at a provider without their complaint history is
   * a degraded deliberation, and it should be visible in the logs that
   * it happened.
   */
  private degraded(
    providerId: string,
    reason: Provider360IncidentsUnavailableReason,
    traceId: string | undefined,
  ): Provider360IncidentsSection {
    this.logger.warn(
      { providerId, reason, traceId },
      'provider-360: incident section unavailable — rendering the composed view without it',
    );
    return { state: 'unavailable', reason };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Upstream result readers
// ─────────────────────────────────────────────────────────────────────

type IncidentPage =
  | {
      readonly kind: 'ok';
      readonly incidents: readonly TrustSafetyIncidentSummary[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: Provider360IncidentsUnavailableReason;
    };

/**
 * Translate one incident-scroll result into a page or a degradation
 * reason. Returns rather than throws — the caller composes the section.
 *
 * A 4xx is mapped to `upstream_error` rather than propagated: the only
 * 4xx reachable here is a permission or validation failure the gateway
 * itself constructed the request for, which is a bug on our side, not
 * a client error the committee can act on. It is logged by the caller.
 */
function readIncidentPage(result: DownstreamResult): IncidentPage {
  switch (result.kind) {
    case 'ok': {
      const parsed = TrustSafetyIncidentListResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        return { kind: 'unavailable', reason: 'contract_drift' };
      }
      return {
        kind: 'ok',
        incidents: parsed.data.incidents,
        // Conservative: a page that came back exactly full is reported
        // truncated even when nothing was dropped. Over-reporting
        // incompleteness is the right way to be wrong here.
        truncated: parsed.data.incidents.length >= TRUST_SAFETY_INCIDENT_QUEUE_LIMIT_MAX,
      };
    }
    case 'client_error':
      return { kind: 'unavailable', reason: 'upstream_error' };
    case 'server_error':
      return { kind: 'unavailable', reason: 'upstream_error' };
    case 'timeout':
      return { kind: 'unavailable', reason: 'timeout' };
    case 'network_error':
      return { kind: 'unavailable', reason: 'unreachable' };
    case 'not_configured':
      return { kind: 'unavailable', reason: 'not_configured' };
  }
}

/**
 * Translate the dossier result into the parsed body, or throw. This
 * upstream is load-bearing: without the provider's identity there is
 * no page to render, so every failure mode ends the request.
 */
function mapDossierResult(
  result: DownstreamResult,
  traceId: string | undefined,
): ProviderDossierResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = ProviderDossierResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail:
            'Downstream service-provider returned a body that does not conform to the provider-dossier contract.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      if (result.status === HttpStatus.NOT_FOUND) {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: 'Provider not found.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-provider did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure PROVIDER_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
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
      status: HttpStatus.UNAUTHORIZED,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
