import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  InternalSeniorPrepSnapshotResponseSchema,
  RECOMMENDATION_PROFILE_TAGS_MAX,
  RecommendProvidersRequestSchema,
  RecommendProvidersResponseSchema,
  SeniorPreferencesResponseSchema,
  SeniorRecommendedProvidersResponseSchema,
  type InternalSeniorPrepSnapshotResponse,
  type RecommendProvidersResponse,
  type RecommendationSeniorProfile,
  type SeniorPreferencesResponse,
  type SeniorRecommendedProvidersResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Senior match-recommendations BFF aggregator (TS-213).
 *
 *   GET /api/v1/seniors/:seniorId/recommended-providers
 *     Returns the top providers matched to a senior's preferences +
 *     household intake, each with explainability metadata. Aggregates
 *     three upstream hops:
 *
 *       1. `service-household` — the senior's memory-profile preferences
 *          read via the actor's OWN token
 *          (`GET /api/v1/seniors/:seniorId/preferences`). This both
 *          enforces the actor↔senior household-membership authz (the
 *          downstream 403/404s a non-member) AND yields the cuisine /
 *          tradition cues.
 *       2. `service-household` — the senior's operational intake
 *          (languages, dietary tags, dementia status) + memory recipes
 *          (the meal-history cuisine cues) via the internal shared-secret
 *          prep-snapshot endpoint. The actor↔senior link is already
 *          established by hop 1, so this hop trusts the gateway.
 *       3. `service-search` — the scoring engine, via the internal
 *          shared-secret recommendations endpoint. The gateway sends a
 *          DE-IDENTIFIED signal profile (no seniorId, no PII) — service-
 *          search never reads senior data (CLAUDE.md §2.3, §12).
 *
 * **Why the gateway owns this endpoint.** The PRD phrases it as living
 * on service-search; in practice service-search has no cross-service
 * access to the household domain, so the scoring lives there (hop 3) and
 * the senior-keyed surface + authz lives at the gateway. Exactly the
 * TS-208 visit-prep split.
 *
 * **Authorization.** Family self-service via hop 1 — the actor must
 * be authenticated (AccessTokenGuard) and must have household access to
 * the senior (the downstream preferences read enforces it; a non-member
 * gets 403/404, forwarded verbatim).
 *
 * **Failure modes.**
 *   - 401 — missing/invalid access token.
 *   - 403 / 404 — actor lacks access to the senior (forwarded from the
 *           preferences read).
 *   - 502 — any upstream unreachable / malformed / shared-secret
 *           misconfigured.
 *   - 503 — a required shared secret is unset on the gateway env, or an
 *           upstream service base URL is unconfigured.
 *   - 504 — any upstream times out.
 *
 * **No idempotency-key handling** — GET is naturally idempotent.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SeniorRecommendationsAggregatorController {
  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  @Get(':seniorId/recommended-providers')
  @HttpCode(HttpStatus.OK)
  async getRecommendedProviders(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorRecommendedProvidersResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Fail fast on a missing shared secret — better a 503 with a
    // specific detail line than a confusing 401/502 from a later hop.
    if (this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY === undefined) {
      throw missingSecret(
        'household visit-prep endpoint. Configure HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY',
        traceId,
      );
    }
    if (this.env.SEARCH_INDEX_API_KEY === undefined) {
      throw missingSecret(
        'search recommendations endpoint. Configure SEARCH_INDEX_API_KEY',
        traceId,
      );
    }

    // Hop 1 — preferences read with the actor's own token. Doubles as the
    // actor↔senior authz gate (downstream 403/404 for a non-member).
    const preferencesResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/preferences`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const preferences = mapPreferencesResult(preferencesResult, traceId);

    // Hop 2 — operational intake via the internal shared-secret endpoint.
    // No `actor` — the endpoint pins the shared secret, not the actor
    // trust headers; the actor↔senior link was established by hop 1.
    const prepResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/internal/seniors/${encodeURIComponent(seniorId)}/prep-snapshot`,
      method: 'GET',
      traceId,
      extraHeaders: {
        [this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME]:
          this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY,
      },
    });
    const prep = mapPrepSnapshotResult(prepResult, traceId);

    // Assemble the DE-IDENTIFIED signal profile — no seniorId / name / PII
    // crosses to service-search.
    const profile = buildSignalProfile(prep, preferences);
    const recommendRequest = RecommendProvidersRequestSchema.parse({ profile });

    // Hop 3 — the service-search scoring engine via its internal
    // shared-secret endpoint.
    const recommendResult = await this.downstream.call({
      service: 'search',
      path: '/api/v1/internal/search/recommendations',
      method: 'POST',
      body: recommendRequest,
      traceId,
      // idempotency: a hop the gateway synthesises, not a write the caller
      // made. This is the scoring engine, invoked with a de-identified signal
      // profile the aggregator just built; the client never issued it and has
      // no key that means anything here. Forwarding the caller's key would key
      // an internal read against the same value as their outer request.
      idempotencyKey: undefined,
      extraHeaders: {
        [this.env.SEARCH_INDEX_HEADER_NAME]: this.env.SEARCH_INDEX_API_KEY,
      },
    });
    const recommendations = mapRecommendationsResult(recommendResult, traceId);

    // Final aggregation. Parse at the boundary so any future drift
    // surfaces here rather than at the web-family consumer. `liveMode` is
    // an internal ops detail and is dropped from the public response.
    return SeniorRecommendedProvidersResponseSchema.parse({
      seniorId,
      recommendations: recommendations.recommendations,
      generatedAt: new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Signal-profile assembly. Normalises upstream intake + preference data
// into the de-identified tag shape service-search scores against. Every
// tag is lower-cased and validated against the contract tag pattern;
// anything that doesn't conform is dropped (best-effort matching, never a
// 400 for a stray upstream tag).
// ─────────────────────────────────────────────────────────────────────

/**
 * Senior-preference keys whose free-text values carry cuisine / culinary
 * cues. The values are tokenised into candidate cuisine tags matched
 * against the provider doc's `cuisines`. The preference vocabulary is
 * open (TS-214), so this is the curated subset the gateway mines; a
 * richer extraction (TS-216 synonym dictionary) is a follow-up.
 */
const CUISINE_PREFERENCE_KEYS: readonly string[] = [
  'favorite_cuisine',
  'favorite_food',
  'favorite_dish',
  'favorite_childhood_dish',
  'favorite_childhood_food',
  'comfort_food',
  'regional_tradition',
  'cultural_holiday',
  'cuisine',
];

/** Minimum token length when mining cuisine cues — drops "of", "an", etc. */
const MIN_CUISINE_TOKEN_LENGTH = 3;

const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TAG_MAX_LENGTH = 64;

function normalizeTag(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0 || lower.length > TAG_MAX_LENGTH) return null;
  return TAG_PATTERN.test(lower) ? lower : null;
}

function normalizeTagList(raws: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const tag = normalizeTag(raw);
    if (tag !== null && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
      if (out.length >= RECOMMENDATION_PROFILE_TAGS_MAX) break;
    }
  }
  return out;
}

/**
 * Mine cuisine cues for the "meal-history affinity" signal (PRD §6.3)
 * from two sources, in priority order:
 *
 *   1. **Memory-recipe cuisine tags** — the structured `cuisineTag` on
 *      each of the senior's memory recipes (the dishes that are
 *      meaningful to them). This IS the meal history — a precise,
 *      already-tag-shaped signal.
 *   2. **Preference free-text** — the curated cuisine/tradition
 *      preference values, tokenised into candidate tags.
 *
 * Deduped, normalised to the contract tag shape, and capped. Memory
 * recipes lead because they're structured + biographically grounded.
 */
function deriveCuisineCues(
  prep: InternalSeniorPrepSnapshotResponse,
  preferences: SeniorPreferencesResponse,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (candidate: string): boolean => {
    if (seen.has(candidate)) return true;
    seen.add(candidate);
    out.push(candidate);
    return out.length < RECOMMENDATION_PROFILE_TAGS_MAX;
  };

  // 1. Memory-recipe cuisine tags (meal history).
  for (const recipe of prep.memoryRecipes) {
    if (recipe.cuisineTag === null) continue;
    const tag = normalizeTag(recipe.cuisineTag);
    if (tag !== null && !push(tag)) return out;
  }

  // 2. Preference free-text cues.
  const keys = new Set(CUISINE_PREFERENCE_KEYS);
  for (const entry of preferences.preferences) {
    if (!keys.has(entry.key)) continue;
    for (const token of entry.value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < MIN_CUISINE_TOKEN_LENGTH) continue;
      if (!TAG_PATTERN.test(token)) continue;
      if (!push(token)) return out;
    }
  }
  return out;
}

function buildSignalProfile(
  prep: InternalSeniorPrepSnapshotResponse,
  preferences: SeniorPreferencesResponse,
): RecommendationSeniorProfile {
  return {
    languages: normalizeTagList(prep.senior.languageTags),
    dietaryTags: normalizeTagList(prep.senior.dietaryTags),
    cuisinePreferences: deriveCuisineCues(prep, preferences),
    dementiaSensitive: prep.senior.dementiaStatus !== 'none',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-upstream result mappers. Mirror the TS-208 visit-prep aggregator
// shape — each translates the `DownstreamResult` discriminated union into
// either a parsed body or a thrown RFC 7807 HTTP exception, naming the
// actual downstream in the detail line.
// ─────────────────────────────────────────────────────────────────────

function mapPreferencesResult(
  result: DownstreamResult,
  traceId: string | undefined,
): SeniorPreferencesResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = SeniorPreferencesResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw badGateway(
          'Downstream service-household returned a body that does not conform to the preferences contract.',
          traceId,
        );
      }
      return parsed.data;
    }
    case 'client_error': {
      // Forward the downstream 403/404 (non-member / missing senior)
      // verbatim — the actor↔senior authz gate lives here.
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error':
      throw badGateway('Downstream service-household returned an unsuccessful response.', traceId);
    case 'timeout':
      throw gatewayTimeout(
        'Downstream service-household did not respond within the timeout window.',
        traceId,
      );
    case 'network_error':
      throw badGateway('Downstream service-household is unreachable.', traceId);
    case 'not_configured':
      throw notConfigured('household', 'HOUSEHOLD_SERVICE_BASE_URL', traceId);
  }
}

function mapPrepSnapshotResult(
  result: DownstreamResult,
  traceId: string | undefined,
): InternalSeniorPrepSnapshotResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = InternalSeniorPrepSnapshotResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw badGateway(
          'Downstream service-household returned a body that does not conform to the prep-snapshot contract.',
          traceId,
        );
      }
      return parsed.data;
    }
    case 'client_error':
      // A 401 here means the shared secret is misconfigured — surface as
      // 502 (the actor's own auth is fine). Any other 4xx after hop 1
      // already authorised the actor is similarly a misconfig.
      throw badGateway(
        `Downstream service-household rejected the internal prep-snapshot request (status ${result.status}).`,
        traceId,
      );
    case 'server_error':
      throw badGateway('Downstream service-household returned an unsuccessful response.', traceId);
    case 'timeout':
      throw gatewayTimeout(
        'Downstream service-household did not respond within the timeout window.',
        traceId,
      );
    case 'network_error':
      throw badGateway('Downstream service-household is unreachable.', traceId);
    case 'not_configured':
      throw notConfigured('household', 'HOUSEHOLD_SERVICE_BASE_URL', traceId);
  }
}

function mapRecommendationsResult(
  result: DownstreamResult,
  traceId: string | undefined,
): RecommendProvidersResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = RecommendProvidersResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw badGateway(
          'Downstream service-search returned a body that does not conform to the recommendations contract.',
          traceId,
        );
      }
      return parsed.data;
    }
    case 'client_error':
      // A 401 here means the SEARCH_INDEX shared secret is misconfigured;
      // a 4xx after the gateway validated the request body is a misconfig.
      throw badGateway(
        `Downstream service-search rejected the internal recommendations request (status ${result.status}).`,
        traceId,
      );
    case 'server_error':
      throw badGateway('Downstream service-search returned an unsuccessful response.', traceId);
    case 'timeout':
      throw gatewayTimeout(
        'Downstream service-search did not respond within the timeout window.',
        traceId,
      );
    case 'network_error':
      throw badGateway('Downstream service-search is unreachable.', traceId);
    case 'not_configured':
      throw notConfigured('search', 'SEARCH_SERVICE_BASE_URL', traceId);
  }
}

// ─── Exception + helper factories ───────────────────────────────────────

function missingSecret(detail: string, traceId: string | undefined): ServiceUnavailableException {
  return new ServiceUnavailableException({
    type: 'about:blank',
    title: 'Service Unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail: `Gateway has no shared secret for the ${detail}.`,
    ...(traceId !== undefined && { traceId }),
  });
}

function badGateway(detail: string, traceId: string | undefined): BadGatewayException {
  return new BadGatewayException({
    type: 'about:blank',
    title: 'Bad Gateway',
    status: HttpStatus.BAD_GATEWAY,
    detail,
    ...(traceId !== undefined && { traceId }),
  });
}

function gatewayTimeout(detail: string, traceId: string | undefined): GatewayTimeoutException {
  return new GatewayTimeoutException({
    type: 'about:blank',
    title: 'Gateway Timeout',
    status: HttpStatus.GATEWAY_TIMEOUT,
    detail,
    ...(traceId !== undefined && { traceId }),
  });
}

function notConfigured(
  service: string,
  envVar: string,
  traceId: string | undefined,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    type: 'about:blank',
    title: 'Service Unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail: `Gateway has no route for the '${service}' service. Configure ${envVar}.`,
    ...(traceId !== undefined && { traceId }),
  });
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
