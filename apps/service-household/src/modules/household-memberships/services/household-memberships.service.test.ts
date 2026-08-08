import { HOUSEHOLD_MEMBERSHIPS_MAX, HOUSEHOLD_PRIMARY_PAYERS_MAX } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { HouseholdMembershipsService } from './household-memberships.service';

/**
 * HouseholdMembershipsService tests (TS-505d2-followup-5).
 *
 * The properties worth pinning are all about the QUERY, because the
 * query is the authorisation decision: which rows count as a membership,
 * in what order, and what happens past the cap.
 */

function makePrisma(rows: ReadonlyArray<{ householdId: string; memberRole: string }>): {
  prisma: PrismaService;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    prisma: { householdMember: { findMany } } as unknown as PrismaService,
    findMany,
  };
}

describe('HouseholdMembershipsService', () => {
  let service: HouseholdMembershipsService;
  let findMany: ReturnType<typeof vi.fn>;

  function build(rows: ReadonlyArray<{ householdId: string; memberRole: string }>): void {
    const made = makePrisma(rows);
    findMany = made.findMany;
    service = new HouseholdMembershipsService(made.prisma);
  }

  beforeEach(() => {
    build([{ householdId: 'hh_b', memberRole: 'primary_payer' }]);
  });

  it('counts a membership as active on `removedAt: null` alone', async () => {
    // Deliberately copied from the nine other call sites in this service
    // rather than reasoned about afresh. `acceptedAt` is NOT part of it:
    // an invited-but-unaccepted member counts everywhere else on the
    // platform, and a stricter rule here alone would let a user read a
    // household through `/api/v1/me/seniors` that the gateway then
    // refuses to scope them to.
    await service.listForUser({ userId: 'usr_1' });
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where).toEqual({ userId: 'usr_1', removedAt: null });
    expect(where).not.toHaveProperty('acceptedAt');
  });

  it('orders deterministically so a cached list and a fresh one agree', async () => {
    await service.listForUser({ userId: 'usr_1' });
    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([{ householdId: 'asc' }]);
  });

  it('projects only householdId + memberRole', async () => {
    // A hot-path internal route consumed by an authorisation decision is
    // the last place to widen a projection — no names, no seniors, no
    // addresses.
    await service.listForUser({ userId: 'usr_1' });
    expect(findMany.mock.calls[0]?.[0]?.select).toEqual({
      householdId: true,
      memberRole: true,
    });
  });

  it('returns an empty list for a user with no memberships', async () => {
    build([]);
    await expect(service.listForUser({ userId: 'usr_none' })).resolves.toEqual({
      memberships: [],
    });
  });

  it('returns every membership for a user who belongs to several', async () => {
    // The adult child paying for two parents. This is the shape that makes
    // the `X-Household-Id` disambiguator necessary at the gateway.
    build([
      { householdId: 'hh_a', memberRole: 'primary_payer' },
      { householdId: 'hh_b', memberRole: 'family_observer' },
    ]);
    const result = await service.listForUser({ userId: 'usr_2' });
    expect(result.memberships).toEqual([
      { householdId: 'hh_a', memberRole: 'primary_payer' },
      { householdId: 'hh_b', memberRole: 'family_observer' },
    ]);
  });

  describe('the contract cap', () => {
    it('takes one more row than the cap so a breach is detectable', async () => {
      // `take: MAX` would silently truncate into a smaller, wrong answer
      // with nothing to notice it by.
      await service.listForUser({ userId: 'usr_1' });
      expect(findMany.mock.calls[0]?.[0]?.take).toBe(HOUSEHOLD_MEMBERSHIPS_MAX + 1);
    });

    it('serves the capped list rather than failing, when the cap is breached', async () => {
      // A 500 here would lock the account out of every household-scoped
      // surface. Truncate, but WARN — see the service.
      build(
        Array.from({ length: HOUSEHOLD_MEMBERSHIPS_MAX + 1 }, (_, i) => ({
          householdId: `hh_${String(i).padStart(3, '0')}`,
          memberRole: 'family_observer',
        })),
      );
      const result = await service.listForUser({ userId: 'usr_many' });
      expect(result.memberships).toHaveLength(HOUSEHOLD_MEMBERSHIPS_MAX);
    });
  });
});

/**
 * `resolveBillingContacts` tests (TS-042-followup-3a1).
 *
 * This route is the missing first hop of every family-facing billing
 * notification: a subscription's `customer_id` is a `households.id`, and
 * nothing on the platform could turn one into a person. The properties
 * worth pinning are the query's exclusions (who must NOT come back) and the
 * shape of "nobody pays for this household".
 */
describe('HouseholdMembershipsService.resolveBillingContacts', () => {
  function buildFor(rows: ReadonlyArray<{ householdId: string; userId: string }>): {
    service: HouseholdMembershipsService;
    findMany: ReturnType<typeof vi.fn>;
  } {
    const findMany = vi.fn().mockResolvedValue(rows);
    return {
      service: new HouseholdMembershipsService({
        householdMember: { findMany },
      } as unknown as PrismaService),
      findMany,
    };
  }

  it('asks only for active primary payers', async () => {
    const { service, findMany } = buildFor([]);
    await service.resolveBillingContacts({ householdIds: ['hh_1', 'hh_2'] });

    // Observers and seniors are excluded HERE, not left to the caller: a
    // senior learning by email that their care is about to lapse for
    // non-payment is a §12 dignity failure, and the route that would hand
    // out their user id is where that has to be impossible.
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      householdId: { in: ['hh_1', 'hh_2'] },
      memberRole: 'primary_payer',
      removedAt: null,
    });
  });

  it('uses the same `removedAt: null` activeness rule as listForUser', async () => {
    const { service, findMany } = buildFor([]);
    await service.resolveBillingContacts({ householdIds: ['hh_1'] });
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    // A definition that differs here from the other ten call sites gives a
    // household that can be acted in but not billed for, or the reverse.
    expect(where).not.toHaveProperty('acceptedAt');
  });

  it('projects only householdId + userId — no names, no emails', async () => {
    const { service, findMany } = buildFor([]);
    await service.resolveBillingContacts({ householdIds: ['hh_1'] });
    expect(findMany.mock.calls[0]?.[0]?.select).toEqual({ householdId: true, userId: true });
  });

  it('groups multiple payers under one household rather than picking one', async () => {
    // A couple sharing responsibility for a parent's care is a legitimate
    // shape and there is no unique index preventing it. Picking one would
    // silently never tell the second payer their card failed.
    const { service } = buildFor([
      { householdId: 'hh_1', userId: 'usr_a' },
      { householdId: 'hh_1', userId: 'usr_b' },
      { householdId: 'hh_2', userId: 'usr_c' },
    ]);
    const result = await service.resolveBillingContacts({ householdIds: ['hh_1', 'hh_2'] });
    expect(result.contacts).toEqual([
      { householdId: 'hh_1', payerUserIds: ['usr_a', 'usr_b'] },
      { householdId: 'hh_2', payerUserIds: ['usr_c'] },
    ]);
  });

  it('omits a household with no active payer rather than returning an empty array', async () => {
    // "Nobody pays for this household" is an escalation for a human. An
    // empty array reads at a glance like a successful resolution that found
    // nobody, which is how a family stops being told anything.
    const { service } = buildFor([{ householdId: 'hh_1', userId: 'usr_a' }]);
    const result = await service.resolveBillingContacts({
      householdIds: ['hh_1', 'hh_no_payer'],
    });
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts.map((c) => c.householdId)).toEqual(['hh_1']);
  });

  it('orders deterministically so a retry produces byte-identical output', async () => {
    const { service, findMany } = buildFor([]);
    await service.resolveBillingContacts({ householdIds: ['hh_1'] });
    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { householdId: 'asc' },
      { userId: 'asc' },
    ]);
  });

  it('caps payers per household at the contract maximum', async () => {
    const { service } = buildFor(
      Array.from({ length: HOUSEHOLD_PRIMARY_PAYERS_MAX + 3 }, (_, i) => ({
        householdId: 'hh_1',
        userId: `usr_${String(i).padStart(3, '0')}`,
      })),
    );
    const result = await service.resolveBillingContacts({ householdIds: ['hh_1'] });
    expect(result.contacts[0]?.payerUserIds).toHaveLength(HOUSEHOLD_PRIMARY_PAYERS_MAX);
  });

  it('short-circuits an empty batch without touching the database', async () => {
    const { service, findMany } = buildFor([]);
    const result = await service.resolveBillingContacts({ householdIds: [] });
    expect(result).toEqual({ contacts: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});
