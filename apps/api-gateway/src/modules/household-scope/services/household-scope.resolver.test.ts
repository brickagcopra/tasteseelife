import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { DownstreamHttpClient } from '../../service-registry/services/downstream-http-client';
import { HouseholdScopeResolver } from './household-scope.resolver';

/**
 * HouseholdScopeResolver tests (TS-505d2-followup-5).
 *
 * The security property under test, stated once: **a user can only ever
 * be scoped to a household in their own membership list.** Everything
 * else here is about which of the four no-scope outcomes applies and
 * whether each one fails closed.
 */

const API_KEY = 'm'.repeat(48);
const HEADER = 'x-household-memberships-internal-api-key';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: HEADER,
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: API_KEY,
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    ...overrides,
  } as unknown as Env;
}

/** A Redis double that always misses, so the downstream path is exercised. */
function makeRedis(): {
  redis: Redis;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn().mockResolvedValue(null);
  const set = vi.fn().mockResolvedValue('OK');
  return { redis: { get, set } as unknown as Redis, get, set };
}

function okMemberships(memberships: ReadonlyArray<{ householdId: string; memberRole: string }>): {
  kind: 'ok';
  status: number;
  body: unknown;
  setCookies: readonly string[];
} {
  return { kind: 'ok', status: 200, body: { memberships }, setCookies: [] };
}

interface Harness {
  readonly resolver: HouseholdScopeResolver;
  readonly call: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
}

function build(args: { env?: Partial<Env>; downstreamResult?: unknown } = {}): Harness {
  const { redis, get, set } = makeRedis();
  const call = vi.fn().mockResolvedValue(args.downstreamResult ?? okMemberships([]));
  const resolver = new HouseholdScopeResolver(makeEnv(args.env ?? {}), redis, {
    call,
  } as unknown as DownstreamHttpClient);
  return { resolver, call, get, set };
}

function resolveFor(
  h: Harness,
  requestedHouseholdId?: string,
): ReturnType<HouseholdScopeResolver['resolve']> {
  return h.resolver.resolve({
    userId: 'usr_1',
    requestedHouseholdId,
    traceId: 'trace-1',
  });
}

describe('HouseholdScopeResolver', () => {
  describe('the security property', () => {
    it('refuses a household the user does not belong to', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_mine', memberRole: 'primary_payer' }]),
      });
      await expect(resolveFor(h, 'hh_someone_elses')).resolves.toEqual({ kind: 'forbidden' });
    });

    it('refuses any household when the user belongs to none', async () => {
      const h = build({ downstreamResult: okMemberships([]) });
      await expect(resolveFor(h, 'hh_anything')).resolves.toEqual({ kind: 'forbidden' });
    });

    it('scopes to a requested household that IS an active membership', async () => {
      const h = build({
        downstreamResult: okMemberships([
          { householdId: 'hh_a', memberRole: 'primary_payer' },
          { householdId: 'hh_b', memberRole: 'family_observer' },
        ]),
      });
      await expect(resolveFor(h, 'hh_b')).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_b' },
      });
    });

    it('takes the id from the membership row, not from the request', async () => {
      // Belt and braces: the scope must be built from what the downstream
      // returned. If a future edit ever echoed the header back, this fails.
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_a', memberRole: 'primary_payer' }]),
      });
      const result = await resolveFor(h, '  hh_a  ');
      expect(result).toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_a' },
      });
    });
  });

  describe('resolution without a header', () => {
    it('auto-resolves the single membership — no client change needed', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_only', memberRole: 'primary_payer' }]),
      });
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_only' },
      });
    });

    it('is `ambiguous`, NOT a pick, when the user has several households', async () => {
      // The one thing never done: silently acting on the wrong parent's
      // household. It is also not an error — the resolver runs on every
      // authenticated request and cannot know whether this route needs a
      // household at all.
      const h = build({
        downstreamResult: okMemberships([
          { householdId: 'hh_a', memberRole: 'primary_payer' },
          { householdId: 'hh_b', memberRole: 'primary_payer' },
        ]),
      });
      await expect(resolveFor(h)).resolves.toEqual({ kind: 'unscoped', reason: 'ambiguous' });
    });

    it('is `no_memberships` for staff, providers and partner users', async () => {
      const h = build({ downstreamResult: okMemberships([]) });
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'unscoped',
        reason: 'no_memberships',
      });
    });

    it('treats an empty or whitespace header as absent, not as a household named ""', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_only', memberRole: 'primary_payer' }]),
      });
      await expect(resolveFor(h, '   ')).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_only' },
      });
    });
  });

  describe('failing closed', () => {
    it('grants no scope when the shared secret is unconfigured', async () => {
      const h = build({ env: { HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: undefined } });
      await expect(resolveFor(h, 'hh_a')).resolves.toEqual({
        kind: 'unscoped',
        reason: 'disabled',
      });
      expect(h.call).not.toHaveBeenCalled();
    });

    it('grants no scope when service-household is unreachable', async () => {
      const h = build({ downstreamResult: { kind: 'network_error', detail: 'ECONNREFUSED' } });
      await expect(resolveFor(h, 'hh_a')).resolves.toEqual({
        kind: 'unscoped',
        reason: 'lookup_failed',
      });
    });

    it('grants no scope when service-household is not configured on the registry', async () => {
      const h = build({ downstreamResult: { kind: 'not_configured', service: 'household' } });
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'unscoped',
        reason: 'lookup_failed',
      });
    });

    it('grants no scope when the response drifts off contract', async () => {
      // `.strict()` is doing real work: a widened downstream projection
      // must not quietly become a tenant scope.
      const h = build({
        downstreamResult: {
          kind: 'ok',
          status: 200,
          body: { memberships: [{ householdId: 'hh_a', memberRole: 'primary_payer', pii: 'x' }] },
          setCookies: [],
        },
      });
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'unscoped',
        reason: 'lookup_failed',
      });
    });

    it('grants no scope when the response carries an unknown member role', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_a', memberRole: 'landlord' }]),
      });
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'unscoped',
        reason: 'lookup_failed',
      });
    });
  });

  describe('the downstream call', () => {
    it('pins the shared secret and sends no actor context', async () => {
      // Signing an actor here would be circular — the actor's scope is
      // precisely what this call exists to determine.
      const h = build();
      await resolveFor(h);
      const options = h.call.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(options['service']).toBe('household');
      expect(options['path']).toBe('/api/v1/internal/users/usr_1/household-memberships');
      expect(options['extraHeaders']).toEqual({ [HEADER]: API_KEY });
      expect(options['actor']).toBeUndefined();
    });

    it('url-encodes the user id', async () => {
      const h = build();
      await h.resolver.resolve({
        userId: 'usr/../admin',
        requestedHouseholdId: undefined,
        traceId: undefined,
      });
      const path = (h.call.mock.calls[0]?.[0] as Record<string, unknown>)['path'];
      expect(path).toBe('/api/v1/internal/users/usr%2F..%2Fadmin/household-memberships');
    });
  });

  describe('the cache', () => {
    it('is keyed per CLAUDE.md §3.7 and carries the configured TTL', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_a', memberRole: 'primary_payer' }]),
      });
      await resolveFor(h);
      expect(h.set).toHaveBeenCalledWith(
        'test:api-gateway:household-scope:usr_1',
        JSON.stringify({ memberships: [{ householdId: 'hh_a', memberRole: 'primary_payer' }] }),
        'EX',
        60,
      );
    });

    it('serves a hit without calling service-household', async () => {
      const h = build();
      h.get.mockResolvedValue(
        JSON.stringify({ memberships: [{ householdId: 'hh_c', memberRole: 'senior_user' }] }),
      );
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_c' },
      });
      expect(h.call).not.toHaveBeenCalled();
    });

    it('treats an unparseable cached value as a miss and re-reads', async () => {
      // Self-healing rather than an error: the contract changed under a
      // live cache.
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_a', memberRole: 'primary_payer' }]),
      });
      h.get.mockResolvedValue('{"memberships":[{"householdId":1}]}');
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_a' },
      });
      expect(h.call).toHaveBeenCalledTimes(1);
    });

    it('still resolves when Redis is down — the cache is best-effort (§4.3)', async () => {
      const h = build({
        downstreamResult: okMemberships([{ householdId: 'hh_a', memberRole: 'primary_payer' }]),
      });
      h.get.mockRejectedValue(new Error('connection refused'));
      h.set.mockRejectedValue(new Error('connection refused'));
      await expect(resolveFor(h)).resolves.toEqual({
        kind: 'scoped',
        scope: { type: 'household', householdId: 'hh_a' },
      });
    });
  });
});
