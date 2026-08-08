import { describe, expect, it } from 'vitest';

import {
  HouseholdMemberRoleSchema,
  HouseholdMembershipSchema,
  InternalHouseholdMembershipsResponseSchema,
  HOUSEHOLD_MEMBERSHIPS_MAX,
  HOUSEHOLD_SCOPE_HEADER,
} from '../http/household-membership.schema';

/**
 * Household-membership contract tests (TS-505d2-followup-5).
 *
 * This response is not a UI payload — it is the input to an authorisation
 * decision one hop away (the api-gateway turns it into a request's
 * `tenantScope`). So the properties under test are the ones that keep a
 * widened or oversized response from silently becoming a tenant scope.
 */
describe('HouseholdMembershipSchema', () => {
  it('accepts a well-formed membership', () => {
    expect(
      HouseholdMembershipSchema.parse({ householdId: 'hh_1', memberRole: 'primary_payer' }),
    ).toEqual({ householdId: 'hh_1', memberRole: 'primary_payer' });
  });

  it('mirrors service-household`s member-role enum exactly', () => {
    // A value the platform's Postgres enum does not have would mean the
    // schema and the column have drifted.
    expect(HouseholdMemberRoleSchema.options).toEqual([
      'primary_payer',
      'family_observer',
      'senior_user',
    ]);
  });

  it('rejects an unknown member role', () => {
    expect(
      HouseholdMembershipSchema.safeParse({ householdId: 'hh_1', memberRole: 'landlord' }).success,
    ).toBe(false);
  });

  it('rejects an empty household id', () => {
    // An empty id would resolve to a scope nothing can match, which reads
    // downstream as "member of a household called nothing".
    expect(
      HouseholdMembershipSchema.safeParse({ householdId: '', memberRole: 'primary_payer' }).success,
    ).toBe(false);
  });

  it('is strict — a widened downstream projection cannot ride along', () => {
    // The whole reason the gateway re-parses this at its boundary. Nothing
    // about the household but its id may cross this wire.
    expect(
      HouseholdMembershipSchema.safeParse({
        householdId: 'hh_1',
        memberRole: 'primary_payer',
        seniorFirstName: 'Rosa',
      }).success,
    ).toBe(false);
  });
});

describe('InternalHouseholdMembershipsResponseSchema', () => {
  it('accepts an empty list — "none" is a complete answer, not an error', () => {
    expect(InternalHouseholdMembershipsResponseSchema.parse({ memberships: [] })).toEqual({
      memberships: [],
    });
  });

  it('accepts several memberships — the adult child paying for two parents', () => {
    const parsed = InternalHouseholdMembershipsResponseSchema.parse({
      memberships: [
        { householdId: 'hh_a', memberRole: 'primary_payer' },
        { householdId: 'hh_b', memberRole: 'family_observer' },
      ],
    });
    expect(parsed.memberships).toHaveLength(2);
  });

  it('refuses a list longer than the cap', () => {
    // An unbounded response on a per-request authorisation path is a
    // denial-of-service surface; a breach must be a 502 at the gateway,
    // not a slow, silently-truncated decision.
    const oversized = Array.from({ length: HOUSEHOLD_MEMBERSHIPS_MAX + 1 }, (_, i) => ({
      householdId: `hh_${i}`,
      memberRole: 'family_observer' as const,
    }));
    expect(
      InternalHouseholdMembershipsResponseSchema.safeParse({ memberships: oversized }).success,
    ).toBe(false);
  });

  it('accepts a list exactly at the cap', () => {
    const atCap = Array.from({ length: HOUSEHOLD_MEMBERSHIPS_MAX }, (_, i) => ({
      householdId: `hh_${i}`,
      memberRole: 'family_observer' as const,
    }));
    expect(
      InternalHouseholdMembershipsResponseSchema.safeParse({ memberships: atCap }).success,
    ).toBe(true);
  });

  it('is strict at the envelope too', () => {
    expect(
      InternalHouseholdMembershipsResponseSchema.safeParse({
        memberships: [],
        nextCursor: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('HOUSEHOLD_SCOPE_HEADER', () => {
  it('is lower-case, so a header lookup on either side agrees', () => {
    // Express lower-cases incoming header names; the gateway reads this
    // constant directly, and the nine downstream refusal messages
    // interpolate it. A mixed-case value would make the lookup miss.
    expect(HOUSEHOLD_SCOPE_HEADER).toBe(HOUSEHOLD_SCOPE_HEADER.toLowerCase());
    expect(HOUSEHOLD_SCOPE_HEADER).toBe('x-household-id');
  });
});
