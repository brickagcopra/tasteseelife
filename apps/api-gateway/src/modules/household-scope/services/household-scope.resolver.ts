import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantScope } from '@taste-and-see/auth-sdk';
import type { HouseholdMembership } from '@taste-and-see/contracts';
import { InternalHouseholdMembershipsResponseSchema } from '@taste-and-see/contracts';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { GATEWAY_REDIS_TOKEN } from '../../../redis/redis.module';
import { DownstreamHttpClient } from '../../service-registry/services/downstream-http-client';

/**
 * The outcome of trying to establish a request's household tenant scope.
 * A discriminated union rather than `TenantScope | null`, because the
 * caller's three branches are genuinely different decisions — scope the
 * request, leave it alone, or refuse it — and "leave it alone" carries a
 * reason an operator will need.
 */
export type HouseholdScopeResolution =
  | { readonly kind: 'scoped'; readonly scope: TenantScope }
  | { readonly kind: 'unscoped'; readonly reason: UnscopedReason }
  | { readonly kind: 'forbidden' };

/**
 * Why a request was left `global`-scoped.
 *
 *   - `disabled` — no shared secret configured; the seam is off.
 *   - `no_memberships` — the actor belongs to no household. Staff,
 *     providers and partner users live here, and it is the common case.
 *   - `ambiguous` — several memberships and no `X-Household-Id` header.
 *     See `resolve` for why this is not an error.
 *   - `lookup_failed` — service-household could not be reached or
 *     answered off-contract. Fails CLOSED: no scope is granted.
 */
export type UnscopedReason = 'disabled' | 'no_memberships' | 'ambiguous' | 'lookup_failed';

/**
 * Resolves "which household is this request acting in" from the actor's
 * active memberships (TS-505d2-followup-5).
 *
 * **The security property, stated once.** A user can only ever be scoped
 * to a household that appears in their own membership list. The requested
 * household id is never trusted; it is used to SELECT from a list the
 * gateway fetched for that user id, and a value that is not in the list is
 * a 403. That is what makes the header safe to accept from a browser.
 *
 * **Why a cache, and why the TTL is a security parameter.** Without one,
 * every authenticated request on the platform grows an extra hop.
 * `HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS` therefore bounds how long a removed
 * member keeps their scope — and the design this replaced (baking the
 * scope into the access token) bounded it at the token's full 15 minutes,
 * so the default 60s is a fifteen-fold improvement rather than a new
 * exposure. Per CLAUDE.md §4.3 the cache is best-effort: any Redis error
 * degrades to the direct call, never to a wrong answer.
 */
@Injectable()
export class HouseholdScopeResolver {
  private readonly logger = new Logger(HouseholdScopeResolver.name);
  private disabledWarningEmitted = false;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(GATEWAY_REDIS_TOKEN) private readonly redis: Redis,
    private readonly downstream: DownstreamHttpClient,
  ) {}

  /**
   * `requestedHouseholdId` is the raw `X-Household-Id` header value, or
   * undefined when the client sent none.
   *
   * The four outcomes, and why each is what it is:
   *
   *   - **Header present, and a membership matches** → scoped to it.
   *   - **Header present, and no membership matches** → `forbidden`. Not
   *     "ignore it and fall through": a client that named a household is
   *     asking to act in one, and silently acting in a different household
   *     (or none) is worse than a clear refusal.
   *   - **No header, exactly one membership** → scoped to it. This is the
   *     overwhelming majority of family accounts and is what lets every
   *     existing portal work unchanged.
   *   - **No header, several memberships** → `unscoped('ambiguous')`, NOT
   *     an error. The resolver runs on every authenticated request and
   *     cannot know whether this particular route needs a household at
   *     all; erroring here would lock a two-household parent out of
   *     `/api/v1/me` and every admin surface as well. The household-scoped
   *     routes refuse on their own, naming the header. Picking the first
   *     membership is the one thing never done — acting on the wrong
   *     parent's household silently is the failure worth all of this.
   */
  /**
   * The actor's active memberships, or `[]` when they have none or the
   * lookup failed (TS-505d2-followup-5a).
   *
   * Exposed for `GET /api/v1/me`, which answers "which households COULD this
   * actor act in" — a different question from `tenantScope`'s "which one is
   * this request acting in", and the one the family portal needs to render a
   * picker. Behind the same cache, so on any request that already resolved a
   * scope this costs a Redis hit and no downstream call.
   *
   * **A failed lookup returns `[]`, not a throw.** `/me` also carries the
   * roles and MFA state a portal renders its whole shell from, and taking
   * that down because service-household is unreachable would turn a degraded
   * family surface into a broken session. The empty list is honest: the
   * gateway could not establish a membership, and it did not grant one
   * either.
   */
  async listMemberships(args: {
    readonly userId: string;
    readonly traceId: string | undefined;
  }): Promise<readonly HouseholdMembership[]> {
    if (this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY === undefined) {
      this.warnDisabledOnce();
      return [];
    }
    return (await this.loadMemberships(args.userId, args.traceId)) ?? [];
  }

  async resolve(args: {
    readonly userId: string;
    readonly requestedHouseholdId: string | undefined;
    readonly traceId: string | undefined;
  }): Promise<HouseholdScopeResolution> {
    if (this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY === undefined) {
      this.warnDisabledOnce();
      return { kind: 'unscoped', reason: 'disabled' };
    }

    const memberships = await this.loadMemberships(args.userId, args.traceId);
    if (memberships === null) {
      return { kind: 'unscoped', reason: 'lookup_failed' };
    }

    const requested = normaliseRequestedId(args.requestedHouseholdId);
    if (requested !== undefined) {
      const match = memberships.find((m) => m.householdId === requested);
      if (match === undefined) {
        // Do NOT log the requested id at info — a rejected id is
        // attacker-controlled input. The user id + the count of what they
        // do hold is what an operator needs.
        this.logger.warn(
          { userId: args.userId, membershipCount: memberships.length },
          'household scope refused — requested household is not an active membership',
        );
        return { kind: 'forbidden' };
      }
      return { kind: 'scoped', scope: { type: 'household', householdId: match.householdId } };
    }

    const first = memberships[0];
    if (first === undefined) {
      return { kind: 'unscoped', reason: 'no_memberships' };
    }
    if (memberships.length > 1) {
      return { kind: 'unscoped', reason: 'ambiguous' };
    }
    return { kind: 'scoped', scope: { type: 'household', householdId: first.householdId } };
  }

  /**
   * Cache-then-fetch. Returns `null` when the membership list could not be
   * established at all — the caller turns that into "no scope granted",
   * which is the fail-closed direction.
   */
  private async loadMemberships(
    userId: string,
    traceId: string | undefined,
  ): Promise<readonly HouseholdMembership[] | null> {
    const cached = await this.readCache(userId);
    if (cached !== null) return cached;

    const apiKey = this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY;
    if (apiKey === undefined) return null;

    const result = await this.downstream.call({
      service: 'household',
      path: `/api/v1/internal/users/${encodeURIComponent(userId)}/household-memberships`,
      method: 'GET',
      // Deliberately no `actor`: this route pins the shared secret, and
      // signing an actor context here would be circular — the actor's
      // scope is precisely what this call exists to determine.
      traceId,
      extraHeaders: {
        [this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME]: apiKey,
      },
    });

    if (result.kind !== 'ok') {
      // One line per failed resolution, at warn. This is the signal that
      // says "the family surfaces are refusing right now", and it must not
      // be silent — CLAUDE.md §3.9 bans swallowing.
      this.logger.warn(
        {
          userId,
          outcome: result.kind,
          ...(result.kind === 'client_error' || result.kind === 'server_error'
            ? { status: result.status }
            : {}),
        },
        'household membership lookup failed — request stays global-scoped',
      );
      return null;
    }

    const parsed = InternalHouseholdMembershipsResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      // Contract drift on an authorisation input. Refuse the value rather
      // than coerce it: the whole point of `.strict()` here is that a
      // widened downstream projection cannot quietly become a scope.
      this.logger.error(
        { userId, issues: parsed.error.issues.length },
        'household membership response failed contract validation — request stays global-scoped',
      );
      return null;
    }

    await this.writeCache(userId, parsed.data.memberships);
    return parsed.data.memberships;
  }

  /**
   * `{env}:{service}:{purpose}:{id}` per CLAUDE.md §3.7. No tenant segment
   * — the key is per USER, and which tenants that user may act in is the
   * very thing stored here.
   */
  private cacheKey(userId: string): string {
    return `${this.env.NODE_ENV}:api-gateway:household-scope:${userId}`;
  }

  private async readCache(userId: string): Promise<readonly HouseholdMembership[] | null> {
    try {
      const raw = await this.redis.get(this.cacheKey(userId));
      if (raw === null) return null;
      const parsed = InternalHouseholdMembershipsResponseSchema.safeParse(JSON.parse(raw));
      // A cached value that no longer parses is treated as a miss, not as
      // an error: the contract changed under a live cache, and re-reading
      // is both correct and self-healing.
      return parsed.success ? parsed.data.memberships : null;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'household-scope cache read failed — falling through to service-household',
      );
      return null;
    }
  }

  private async writeCache(
    userId: string,
    memberships: readonly HouseholdMembership[],
  ): Promise<void> {
    try {
      await this.redis.set(
        this.cacheKey(userId),
        JSON.stringify({ memberships }),
        'EX',
        this.env.HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      // Best-effort by design (CLAUDE.md §4.3) — a failed write costs a
      // hop next request and nothing else.
      this.logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'household-scope cache write failed',
      );
    }
  }

  /**
   * Once, not per request. An unconfigured secret is a deployment fact
   * that does not change between requests, and a per-request warn would
   * bury the log it is trying to make visible.
   */
  private warnDisabledOnce(): void {
    if (this.disabledWarningEmitted) return;
    this.disabledWarningEmitted = true;
    this.logger.warn(
      'HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY is unset — no request can obtain a household ' +
        'tenant scope, so every family-facing household-scoped surface will refuse. ' +
        'Configure it to enable the family dashboard, wellness surfaces, concierge and ' +
        'report-a-concern.',
    );
  }
}

/**
 * Trim, and treat an empty header as absent. A header present with an
 * empty value is a client bug, not a request to act in a household called
 * `""` — and mapping it to `forbidden` would give a confusing 403 where a
 * fall-through to the normal rules is obviously meant.
 */
function normaliseRequestedId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
