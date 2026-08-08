import { PrismaClient } from '@taste-and-see/service-household/prisma/generated';

import { e2eDatabaseUrl } from './fleet';
import { loadRepoEnvExample } from './repo-env';

/**
 * Household-directory setup for the suite (TS-505d2-followup-5).
 *
 * **Why the harness writes these rows directly.** A household is created by
 * the concierge onboarding flow, which is itself a household-scoped surface
 * — so a spec that had to create one through the gateway would need the very
 * scope it is trying to establish. The rows here are the fixture a real
 * deployment's first onboarding produces; the thing under test is what the
 * gateway does with them, not how they got there. Same justification, and the
 * same boundary, as `harness-db.ts`: a test harness, never deployed, holding
 * no request path, pointed at `tastesee_e2e`.
 *
 * The client is service-household's own generated Prisma client, imported by
 * path — not a hand-written INSERT. A raw statement here would be a second
 * definition of a schema this suite exists to observe, and it would keep
 * passing after a column was renamed underneath it.
 */

let client: PrismaClient | undefined;

function householdPrisma(): PrismaClient {
  if (client === undefined) {
    const base = loadRepoEnvExample()['DATABASE_URL'];
    if (base === undefined || base === '') {
      throw new Error('DATABASE_URL missing from .env.example; cannot reach the E2E database.');
    }
    client = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl(base) } } });
  }
  return client;
}

/** Release the household connection. Called from global teardown. */
export async function closeHouseholdDatabase(): Promise<void> {
  if (client !== undefined) {
    await client.$disconnect();
    client = undefined;
  }
}

export interface SeededHousehold {
  readonly householdId: string;
  /**
   * The senior in this household, when one was asked for.
   *
   * A separate opt-in rather than always created: the concern-reporting path
   * needs a household and no senior, and a fixture that always produced both
   * would let a spec pass while depending on a row it never mentions.
   */
  readonly seniorId?: string;
}

/**
 * Create an active household with `userId` as an active member.
 *
 * `memberRole` defaults to `primary_payer` — the family payer, the actor the
 * "report a concern" path is written for.
 *
 * Note what makes the membership *active*: `removedAt` is null. `acceptedAt`
 * is set here too, but only because a real invitation would have been
 * accepted — the resolver does NOT require it, matching every other read in
 * service-household. A fixture that relied on `acceptedAt` would be asserting
 * a rule the platform does not have.
 */
export async function seedHouseholdWithMember(args: {
  readonly userId: string;
  readonly memberRole?: 'primary_payer' | 'family_observer' | 'senior_user';
  /** Also create an active senior in the household, and return its id. */
  readonly withSenior?: boolean;
  /**
   * Additional members, created alongside the first. Used by specs about the
   * consent gate, where the payer and the observer must be in the SAME
   * household — two separate seeded households would make the observer a
   * non-member and produce a 403 that looks like the consent refusal.
   */
  readonly alsoMembers?: ReadonlyArray<{
    readonly userId: string;
    readonly memberRole: 'primary_payer' | 'family_observer' | 'senior_user';
  }>;
}): Promise<SeededHousehold> {
  const prisma = householdPrisma();
  const household = await prisma.household.create({
    data: {
      primaryPayerUserId: args.userId,
      addressLine1: '1 Test Lane',
      addressCity: 'Testville',
      addressRegion: 'CA',
      addressPostalCode: '90001',
      addressCountry: 'US',
      timeZone: 'America/Los_Angeles',
      status: 'active',
      members: {
        create: [
          {
            userId: args.userId,
            memberRole: args.memberRole ?? 'primary_payer',
            acceptedAt: new Date(),
          },
          ...(args.alsoMembers ?? []).map((member) => ({
            userId: member.userId,
            memberRole: member.memberRole,
            acceptedAt: new Date(),
          })),
        ],
      },
      ...(args.withSenior === true
        ? {
            seniors: {
              create: {
                firstName: 'Rosa',
                lastName: 'E2E',
                status: 'active' as const,
              },
            },
          }
        : {}),
    },
    select: { id: true, seniors: { select: { id: true } } },
  });

  const senior = household.seniors[0];
  return {
    householdId: household.id,
    ...(senior === undefined ? {} : { seniorId: senior.id }),
  };
}

/** Narrow `seedHouseholdWithMember({ withSenior: true })`'s optional id. */
export function requireSeniorId(seeded: SeededHousehold): string {
  if (seeded.seniorId === undefined) {
    throw new Error('household was seeded without a senior — pass `withSenior: true`');
  }
  return seeded.seniorId;
}
