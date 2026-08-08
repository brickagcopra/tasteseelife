import { PrismaClient } from '@taste-and-see/service-identity/prisma/generated';

import { E2E_DATABASE_NAME, e2eDatabaseUrl } from './fleet';
import { loadRepoEnvExample } from './repo-env';

/**
 * The harness's own connection to the E2E database (TS-505, TS-505d1).
 *
 * **Why the harness touches the database at all.** Two things the suite has to
 * do have no HTTP surface and should not grow one:
 *
 *   - *Reading a domain event.* The email-verification token exists in
 *     plaintext only inside the `identity.email_verification_requested`
 *     outbox payload (the table holds a SHA-256 digest by design, TS-510).
 *     Standing in for the `service-notification` consumer is the closest a
 *     test can get to being the user who clicks the link; the alternative is
 *     a production route that hands the token to anyone who asks.
 *   - *Minting the first staff account.* `POST /api/v1/rbac/roles/.../grant`
 *     is gated on `rbac:write`, which only a staff account holds — so the
 *     first `super_admin` cannot come from the HTTP surface by construction.
 *     A production bootstrap route would be a privilege-escalation endpoint
 *     shipped to satisfy a test. Writing the `identity.user_roles` row is the
 *     narrower thing, and it is exactly what a real operator does once, by
 *     hand, on day one.
 *
 * **Why this is acceptable here and nowhere else.** CLAUDE.md §17.3 forbids
 * cross-service database access — for *services*. This is a test harness: it
 * is not deployed, it holds no request path, and it points at
 * `tastesee_e2e` (never `tastesee`, see `fleet.ts`).
 *
 * The client is service-identity's own generated Prisma client, imported by
 * path. Not a second schema of our own: a duplicate model definition is a
 * fixture that can silently disagree with the migration it is supposed to be
 * observing.
 *
 * One client for the whole run, closed once in global teardown. Two modules
 * each opening their own pool against the same database is two connection
 * leaks to remember to close rather than one.
 */

let client: PrismaClient | undefined;

export function harnessPrisma(): PrismaClient {
  if (client === undefined) {
    const databaseUrl = e2eDatabaseUrl(requireBaseDatabaseUrl());
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }
  return client;
}

function requireBaseDatabaseUrl(): string {
  const base = loadRepoEnvExample()['DATABASE_URL'];
  if (base === undefined || base === '') {
    throw new Error(`DATABASE_URL missing from .env.example; cannot reach ${E2E_DATABASE_NAME}`);
  }
  return base;
}

/** Release the harness's database connection. Called from global teardown. */
export async function closeHarnessDatabase(): Promise<void> {
  if (client !== undefined) {
    await client.$disconnect();
    client = undefined;
  }
}
