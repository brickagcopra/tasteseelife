/**
 * TS-024-followup-5 — end-to-end RBAC integration.
 *
 * Boots the real `AppModule` against ephemeral Postgres + Redis
 * containers, runs `seedRbacCatalog` against the real database, then
 * exercises the full grant → login → token-verify round-trip over
 * HTTP. The verification step uses `verifyAccessToken` from
 * `@taste-and-see/auth-sdk` — the same surface every downstream
 * consumer (gateway-api, future services) will call — so a drift
 * between the seed catalog, the Prisma schema, or the auth-sdk
 * payload shape surfaces here even if every unit test stays green.
 *
 * Load-bearing properties asserted end-to-end:
 *
 *   1. **Seed catalog idempotency against real Postgres.** The unit
 *      test (`seed.test.ts`) runs the seed against a FakePrisma; this
 *      test runs it against a freshly-migrated database, asserts the
 *      catalog landed with the exact PDD Appendix B shape (11
 *      permissions — Appendix B's 9 plus the TS-224 concierge:read /
 *      concierge:write pair — 17 roles, the documented role↔permission
 *      graph),
 *      and re-runs the seed to confirm idempotency (no duplicate
 *      rows, no extra attaches/detaches on the steady state).
 *
 *   2. **Grant → token roles-claim propagation.** A `RoleAssignment`
 *      granted via `RoleAssignmentService` shows up verbatim in the
 *      access-token `roles` claim on the next `/login` for that user
 *      — including the denormalised permission set. Unit tests cover
 *      the service-side projection against FakePrisma; this test
 *      proves the JWT-side wire shape matches auth-sdk's verifier
 *      contract under a real Postgres + jsonwebtoken signing pass.
 *
 *   3. **Active-window honoured at token-mint time.** A revoked
 *      assignment (revoked_at != null) AND an expired assignment
 *      (expires_at < now) are both filtered out of the roles claim on
 *      the next login. Without this, a revoke would leak into freshly-
 *      issued tokens until they naturally expired — defeating the
 *      whole point of issuing a 15-minute access-token TTL alongside
 *      a rotating refresh family.
 *
 *   4. **Admin-MFA gate (TS-023-followup-1) wired into the
 *      grant-loaded login.** Granting an `ADMIN_ROLE_NAMES` role to a
 *      user who hasn't enrolled MFA must return 403 on the next
 *      `/login` (CLAUDE.md §3.1 — "MFA mandatory for all admin staff").
 *      Customer-facing roles (family_payer) bypass the gate on the
 *      same shape — the test asserts the divergence so a regression
 *      that misclassified one or the other surfaces here.
 *
 *   5. **auth-sdk `verifyAccessToken` parses the live token.** The
 *      test signs an access token via the production `TokenService`
 *      (indirectly, via `/login`), then verifies it with the same
 *      auth-sdk surface a downstream verifier would use — pinning
 *      `algorithms: ['HS256']` and matching the env's issuer /
 *      audience. A drift between the issuer's payload shape and the
 *      auth-sdk's `AccessTokenPayloadSchema` would surface as an
 *      `InvalidTokenError` here, NOT as a runtime crash in a
 *      consumer service.
 *
 * Why a dedicated test file rather than extending
 * `auth.integration.test.ts`. The auth integration test's scope is
 * the signup→login→refresh→reuse-detection wire contract; layering
 * RBAC catalog seeding + grant lifecycle + admin-MFA gate on top
 * would balloon a single file past its concerns. Splitting RBAC into
 * its own file follows the canonical per-concern pattern (PDD §24.1)
 * the auth + MFA integration tests already established. Per-file
 * Testcontainers lifecycle isolation also means a regression in the
 * RBAC surface fails one file's containers without slowing the
 * sibling auth tests' path.
 *
 * Why no supertest. Same as the auth + MFA integration tests —
 * supertest is not on CLAUDE.md §13 approved list. Node 22's native
 * `fetch` + `app.listen(0, '127.0.0.1')` cover the same surface.
 *
 * References: PDD §24.1, §10.2, Appendix B; CLAUDE.md §3.1, §3.2,
 * §9.1; TS-022-followup-5 canonical pattern in
 * `test/integration/auth.integration.test.ts`; TS-023-followup-6
 * sibling shape in `test/integration/mfa.integration.test.ts`.
 */

import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { ADMIN_ROLE_NAMES, verifyAccessToken } from '@taste-and-see/auth-sdk';
import type { RoleAssignment } from '@taste-and-see/auth-sdk';
import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { RoleAssignmentService } from '../../src/modules/rbac/role-assignment.service';
import { seedRbacCatalog } from '../../src/modules/rbac/seed';
import { PERMISSION_CATALOG, ROLE_CATALOG } from '../../src/modules/rbac/seed-catalog';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let database: IsolatedDatabaseHandle;
let app: INestApplication;
let baseUrl: string;
let harnessPrisma: PrismaService;
/**
 * A context-wrapping facade over `RoleAssignmentService` — see the comment at
 * its construction. `Pick` rather than the class, so a method used here without
 * a wrapper is a compile error instead of a runtime `MissingRequestContextError`.
 */
let roleAssignments: Pick<RoleAssignmentService, 'grant' | 'revoke' | 'listForUser'>;

/**
 * Captured at boot — drives `verifyAccessToken` calls without
 * touching `process.env` from inside a test (which would race
 * `loadEnv()`'s cache if a sibling test or future runner ran in
 * parallel inside this file).
 */
let jwtAccessSecret: string;
let jwtIssuer: string;
let jwtAudience: string;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` (TS-009e-followup-2). The shared Redis
  // URL is read directly from the globalSetup-provided value.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_rbac',
    serviceRoot: SERVICE_ROOT,
  });

  // ── Env wiring ────────────────────────────────────────────────────
  //
  // `app.module.ts` evaluates `loadEnv()` at module-load time, so the
  // env block MUST land before the dynamic AppModule import below.
  // Mirrors auth.integration.test.ts deliberately — same load-order
  // contract.
  jwtAccessSecret = randomBytes(48).toString('base64');
  jwtIssuer = 'taste-and-see/service-identity';
  jwtAudience = 'taste-and-see/api';

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = database.databaseUrl;
  process.env.REDIS_URL = inject('redisUrl');
  process.env.JWT_ACCESS_SECRET = jwtAccessSecret;
  process.env.JWT_ISSUER = jwtIssuer;
  process.env.JWT_AUDIENCE = jwtAudience;
  process.env.MFA_TOTP_ENC_KEY = randomBytes(32).toString('base64');
  process.env.MFA_CHALLENGE_SECRET = randomBytes(48).toString('base64');
  process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString('hex')}`;
  process.env.STRIPE_IDENTITY_RETURN_URL = 'https://example.test/kyc/return';
  process.env.KYC_PAYLOAD_ENC_KEY = randomBytes(32).toString('base64');
  process.env.KYC_WEBHOOK_INTERNAL_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY = randomBytes(32).toString('base64');
  process.env.IDENTITY_PRIVACY_EXPORT_API_KEY = randomBytes(32).toString('base64');
  // HTTP-friendly cookie attribute for the loopback round-trip — same
  // posture as the auth integration test.
  process.env.REFRESH_COOKIE_SECURE = 'false';
  // Short access-token TTL — same shape as the auth integration test;
  // not strictly load-bearing for the RBAC test surface but keeps
  // future-added assertions on `expiresIn` deterministic.
  process.env.JWT_ACCESS_TTL_SECONDS = '120';
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = '5';
  // TS-025-followup-1 — keep the IP circuit breaker out of the way
  // (sibling integration tests carry the same override; see
  // auth.integration.test.ts for rationale).
  process.env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW = '100000';

  // TS-506-followup-3b — this fixture is a copy of the app's env contract that
  // nothing covered, and it had fallen behind the schema. The suite was dying
  // inside `loadEnv` before its first assertion, and because the integration
  // lane is not part of `turbo run test` nothing said so.
  // `packages/testing/src/boot/integration-fixture-env.test.ts` now guards it.
  process.env.INTERNAL_TRUST_SIGNING_SECRET = randomBytes(32).toString('hex');
  const [{ NestFactory }, { AppModule }, { RfcProblemFilter }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/app.module'),
    import('@taste-and-see/nest-common'),
  ]);

  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new RfcProblemFilter());
  // Bind to IPv4 loopback explicitly so `fetch(baseUrl)` resolves
  // consistently across Linux / macOS / Windows CI runners — sibling
  // tests do the same.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  baseUrl = baseUrl.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  // Pull the RoleAssignmentService out of the running Nest container.
  // Granting via the live DI graph (rather than a hand-instantiated
  // service) exercises the exact code path that admin tooling will
  // call in production. The harness Prisma below is reserved for
  // operations that have no HTTP surface yet (account activation,
  // direct DB inspection).
  // TS-305d-followup-2b1b — `grant`/`revoke` reach Prisma's typed API through
  // the DI-wired `PrismaService`, so the TS-141 tenant gate fires. In
  // production every caller arrives over HTTP and `TenantContextInterceptor`
  // has seeded a scoped frame; a test calling the service directly has none,
  // and the gate correctly refuses with `MissingRequestContextError`. **The
  // gate is right and the harness was wrong** — the same shape as the
  // rbac-revoker tick TS-309a-followup-2 fixed. Every call is wrapped in a
  // scoped frame with a grep-able reason rather than each of the 17 call sites
  // growing one.
  const assignments = app.get(RoleAssignmentService);
  const tenantStore = app.get<TenantContextStore>(TENANT_CONTEXT_STORE_TOKEN);
  roleAssignments = {
    grant: (args) =>
      runWithoutTenantContext(tenantStore, 'integration-test-rbac-grant', () =>
        assignments.grant(args),
      ),
    revoke: (args) =>
      runWithoutTenantContext(tenantStore, 'integration-test-rbac-revoke', () =>
        assignments.revoke(args),
      ),
    listForUser: (args) =>
      runWithoutTenantContext(tenantStore, 'integration-test-rbac-list', () =>
        assignments.listForUser(args),
      ),
  };

  // Harness-only Prisma client. Used for the same narrow purposes
  // the auth + MFA integration tests use it for: flipping a
  // freshly-signed-up account to `active`, and DB-level cross-checks
  // after a grant/revoke. No production code path consumes it.
  harnessPrisma = new PrismaService({ datasourceUrl: database.databaseUrl });
  await harnessPrisma.onModuleInit();
});

afterAll(async () => {
  if (harnessPrisma) {
    await harnessPrisma.onModuleDestroy();
  }
  if (app) {
    await app.close();
  }
  if (database) {
    await database.drop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// HTTP helpers. Mirror the auth + MFA integration test shape — every
// test shapes its own headers, the helper returns enough of the
// Response for individual assertions to land cleanly.
// ─────────────────────────────────────────────────────────────────────

interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

async function callJson(
  path: string,
  init: { body?: unknown; method?: string; bearer?: string } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.bearer !== undefined) headers['authorization'] = `Bearer ${init.bearer}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const raw = await response.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: response.status, body };
}

/**
 * Per-test email seed so two tests in the same file (or a future
 * runner that fans out) can't collide on the unique-email constraint.
 */
let emailSeed = 0;
function uniqueEmail(prefix = 'rbac'): string {
  emailSeed += 1;
  return `${prefix}+${process.pid}+${Date.now()}+${emailSeed}@tastesee.test`;
}

const VALID_PASSWORD = 'P@ssw0rd-correct-horse-battery-staple';

/**
 * Sign up an account via the real HTTP signup endpoint, then flip it
 * to `active` via the harness Prisma. Returns the new user's id so
 * subsequent grants can target it without re-querying.
 *
 * The activation step stands in for the future email-verification
 * surface (no such endpoint exists today — same posture as the auth
 * and MFA integration tests). Every other state write goes through
 * a real HTTP endpoint.
 */
async function signupActiveUser(email: string): Promise<{ readonly userId: string }> {
  const signup = await callJson('/api/v1/auth/signup', {
    body: { email, password: VALID_PASSWORD },
  });
  if (signup.status !== 201) {
    throw new Error(
      `signup harness invariant: expected 201, got ${signup.status} with body ${JSON.stringify(signup.body)}`,
    );
  }
  const userId = (signup.body as { id: string }).id;
  await harnessPrisma.user.update({
    where: { email },
    data: { status: 'active' },
  });
  return { userId };
}

interface LoginResult {
  readonly status: number;
  readonly accessToken: string | null;
  readonly outcome: string | null;
}

async function login(email: string): Promise<LoginResult> {
  const res = await callJson('/api/v1/auth/login', {
    body: { email, password: VALID_PASSWORD },
  });
  if (res.status !== 200) {
    return { status: res.status, accessToken: null, outcome: null };
  }
  const body = res.body as { outcome: string; accessToken?: string };
  return {
    status: res.status,
    accessToken: body.accessToken ?? null,
    outcome: body.outcome,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('service-identity RBAC integration (TS-024-followup-5)', () => {
  describe('seedRbacCatalog against real Postgres', () => {
    /**
     * The unit test (`apps/service-identity/src/modules/rbac/seed.test.ts`)
     * proves the upsert + reconciliation logic against FakePrisma. The
     * value of running the seed against Postgres is in catching the
     * cases FakePrisma can't reach:
     *
     *  - The compound `(resource, action)` unique constraint on
     *    `identity.permissions` rejects a duplicate insert at the DB
     *    layer.
     *  - The cross-table FK from `role_permissions(role_id)` → `roles(id)`
     *    and `role_permissions(permission_id)` → `permissions(id)`
     *    fires on attach attempts that reference unknown rows.
     *  - `prisma.$transaction` actually commits all-or-nothing — a
     *    mid-flight failure unwinds the partial state, which FakePrisma's
     *    in-memory shape can simulate but doesn't actually prove
     *    against the Postgres MVCC engine.
     *
     * The catalog counts (11 permissions, 17 roles) come straight from
     * `seed-catalog.ts` — `PERMISSION_CATALOG.length` and
     * `ROLE_CATALOG.length`. We assert against those constants
     * rather than hard-coded literals so a future catalog edit
     * doesn't require updating this test in lockstep.
     */
    it('first apply lands the full PDD Appendix B catalog', async () => {
      const report = await seedRbacCatalog(harnessPrisma);

      expect(report.permissionsUpserted).toBe(PERMISSION_CATALOG.length);
      expect(report.rolesUpserted).toBe(ROLE_CATALOG.length);
      expect(report.skippedUnknownPermissions).toEqual([]);

      // ── Cross-check the DB row counts. Bounded query — the catalog
      // is tiny, so a `findMany` without a where is fine here.
      const permissionsCount = await harnessPrisma.permission.count();
      const rolesCount = await harnessPrisma.role.count();
      expect(permissionsCount).toBe(PERMISSION_CATALOG.length);
      expect(rolesCount).toBe(ROLE_CATALOG.length);

      // ── Each role's permission set matches the catalog. The
      // reconciliation logic attaches every entry in `role.permissions`
      // and detaches everything else; a regression that flipped one of
      // those would diverge here.
      for (const cataloged of ROLE_CATALOG) {
        const persisted = await harnessPrisma.role.findUnique({
          where: { name: cataloged.name },
          select: {
            id: true,
            isSystem: true,
            description: true,
            rolePermissions: {
              select: {
                permission: { select: { resource: true, action: true } },
              },
            },
          },
        });
        if (persisted === null) {
          throw new Error(`seed invariant: role "${cataloged.name}" should exist after seeding`);
        }
        expect(persisted.isSystem).toBe(true);
        expect(persisted.description).toBe(cataloged.description);

        const persistedPermissions = persisted.rolePermissions
          .map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
          .sort();
        const expectedPermissions = [...cataloged.permissions].sort();
        expect(persistedPermissions).toEqual(expectedPermissions);
      }
    });

    it('re-running the seed is idempotent — no attaches or detaches on the steady state', async () => {
      // First apply already happened above. A second apply against
      // the same DB must produce zero attach/detach work — every
      // catalog entry already maps to an existing row.
      const report = await seedRbacCatalog(harnessPrisma);

      expect(report.permissionsUpserted).toBe(PERMISSION_CATALOG.length);
      expect(report.rolesUpserted).toBe(ROLE_CATALOG.length);
      expect(report.rolePermissionsAttached).toBe(0);
      expect(report.rolePermissionsDetached).toBe(0);
      expect(report.skippedUnknownPermissions).toEqual([]);

      // Row counts unchanged — the upserts didn't accidentally
      // duplicate anything (the `where: { resource_action: ... }` +
      // `where: { name: ... }` clauses kept the natural keys in
      // play).
      const permissionsCount = await harnessPrisma.permission.count();
      const rolesCount = await harnessPrisma.role.count();
      expect(permissionsCount).toBe(PERMISSION_CATALOG.length);
      expect(rolesCount).toBe(ROLE_CATALOG.length);
    });
  });

  describe('grant → access-token roles claim', () => {
    /**
     * The verification harness used by every assertion in this block.
     * Decodes the access token via auth-sdk and returns the
     * `RequestContext` for direct comparison against the catalog.
     */
    function verifyToken(accessToken: string) {
      return verifyAccessToken(accessToken, {
        secret: jwtAccessSecret,
        algorithms: ['HS256'],
        issuer: jwtIssuer,
        audience: jwtAudience,
      });
    }

    it('a single customer-facing grant propagates into the next token', async () => {
      const email = uniqueEmail('family-payer');
      const { userId } = await signupActiveUser(email);

      await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });

      const result = await login(email);
      expect(result.status).toBe(200);
      expect(result.outcome).toBe('session');
      if (result.accessToken === null) {
        throw new Error('access token absent from successful login');
      }

      const context = verifyToken(result.accessToken);
      expect(context.userId).toBe(userId);
      expect(context.roles).toHaveLength(1);
      const role = context.roles[0]!;
      expect(role.name).toBe('family_payer');
      expect(role.scope).toEqual({ type: 'global' });
      // family_payer carries an empty permission set in Phase 1
      // (PDD §10.2 — customer-facing roles' permissions live at the
      // consuming-service call sites). The denormalised list MUST
      // round-trip empty rather than absent.
      expect(role.permissions).toEqual([]);
      expect(role.expiresAt).toBeUndefined();
    });

    it('grants stack — multiple active assignments all appear in the roles claim', async () => {
      const email = uniqueEmail('stacked-grants');
      const { userId } = await signupActiveUser(email);

      await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });
      // Granting a household-scoped role on top of a global one — the
      // discriminated-union scope MUST round-trip both shapes.
      await roleAssignments.grant({
        userId,
        roleName: 'family_observer',
        scope: { type: 'household', householdId: 'hh_test_abc123' },
      });

      const result = await login(email);
      expect(result.status).toBe(200);
      if (result.accessToken === null) {
        throw new Error('access token absent from successful login');
      }

      const context = verifyToken(result.accessToken);
      expect(context.roles).toHaveLength(2);
      const names = context.roles.map((r) => r.name).sort();
      expect(names).toEqual(['family_observer', 'family_payer']);

      const observer = context.roles.find((r) => r.name === 'family_observer');
      expect(observer?.scope).toEqual({ type: 'household', householdId: 'hh_test_abc123' });
      const payer = context.roles.find((r) => r.name === 'family_payer');
      expect(payer?.scope).toEqual({ type: 'global' });
    });

    it('a revoked assignment is excluded from the next token', async () => {
      const email = uniqueEmail('revoked-grant');
      const { userId } = await signupActiveUser(email);

      const { id: assignmentId } = await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });

      // Sanity: pre-revoke login carries the role.
      const before = await login(email);
      if (before.accessToken === null) throw new Error('pre-revoke login lacked access token');
      expect(verifyToken(before.accessToken).roles).toHaveLength(1);

      // Revoke + re-login. The new token's roles claim MUST drop the
      // assignment — without that, a revoke would only take effect
      // after the original 15-min token naturally expired.
      const revoke = await roleAssignments.revoke({ assignmentId });
      expect(revoke.revoked).toBe(true);

      const after = await login(email);
      if (after.accessToken === null) throw new Error('post-revoke login lacked access token');
      const context = verifyToken(after.accessToken);
      expect(context.roles).toEqual([]);

      // Re-revoking the same assignment is a no-op (idempotency
      // invariant called out in `RoleAssignmentService.revoke` doc).
      const secondRevoke = await roleAssignments.revoke({ assignmentId });
      expect(secondRevoke.revoked).toBe(false);
    });

    it('an expired assignment is excluded from the next token', async () => {
      const email = uniqueEmail('expired-grant');
      const { userId } = await signupActiveUser(email);

      // expiresAt strictly in the past — `getActiveAssignments` reads
      // `(expires_at IS NULL OR expires_at > now)`, so a past value
      // is treated as inactive at query time even though the row
      // remains on disk (the audit trail of historic grants matters,
      // CLAUDE.md §3.6).
      await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
        expiresAt: new Date(Date.now() - 60_000),
      });

      // Also grant an UNEXPIRED role so the token isn't empty — the
      // load-bearing assertion is that the expired one is filtered
      // OUT, not that the user has zero roles overall.
      await roleAssignments.grant({
        userId,
        roleName: 'family_observer',
        scope: { type: 'global' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const result = await login(email);
      if (result.accessToken === null) throw new Error('login lacked access token');
      const context = verifyToken(result.accessToken);

      const names = context.roles.map((r: RoleAssignment) => r.name);
      expect(names).toEqual(['family_observer']);
      // The unexpired assignment's expiresAt MUST round-trip as an
      // ISO-8601 string — auth-sdk's `RoleAssignment` carries the
      // future expiry verbatim so verifiers can apply the
      // `isAssignmentActive` rule against the token-claim's snapshot.
      const observer = context.roles[0]!;
      expect(typeof observer.expiresAt).toBe('string');
      expect(observer.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('a fresh signup with no grants carries an empty roles claim', async () => {
      // The customer-facing self-service signup path does not grant
      // any role today — TS-024-followup-2 captures that follow-up
      // (assigns family_payer on Tier 1/2 signup once household scoping
      // is in place). Until then a freshly-signed-up account logs in
      // with an empty roles claim, NOT a null one — auth-sdk's
      // `AccessTokenPayloadSchema` requires `roles: z.array(...)` so a
      // missing field would fail verification. Pinning that shape
      // here defends against a future regression that conditionally
      // omits the claim for users with no assignments.
      const email = uniqueEmail('no-grants');
      await signupActiveUser(email);

      const result = await login(email);
      if (result.accessToken === null) throw new Error('login lacked access token');
      const context = verifyToken(result.accessToken);
      expect(context.roles).toEqual([]);
      expect(context.mfaVerified).toBe(false);
      expect(context.tenantScope).toEqual({ type: 'global' });
    });
  });

  describe('admin-MFA gate against the seeded catalog (TS-023-followup-1)', () => {
    /**
     * The combined-gate test surface that proves three things at once:
     *  (a) the seeded admin roles are recognised as admin by
     *      `holdsAnyRole(userId, ADMIN_ROLE_NAMES)`,
     *  (b) the gate refuses to issue a session for an admin-role-
     *      holder whose `mfa_enabled` is false,
     *  (c) the gate does NOT fire for customer-facing roles on the
     *      same shape, so the divergence is structural rather than
     *      "the test always 403s".
     */
    it('refuses to issue a session for an operations_manager grant without MFA', async () => {
      const email = uniqueEmail('admin-no-mfa');
      const { userId } = await signupActiveUser(email);

      // operations_manager is in ADMIN_ROLE_NAMES per
      // `packages/auth-sdk/src/roles.ts`. Granting it before the user
      // has enrolled MFA is exactly the chicken-and-egg case the
      // admin-MFA gate is defending against — the runbook is "enrol
      // MFA first, then promote", and the gate enforces it.
      await roleAssignments.grant({
        userId,
        roleName: 'operations_manager',
        scope: { type: 'global' },
      });

      // Sanity: the catalog entry IS in ADMIN_ROLE_NAMES — without
      // this assertion a future drift could make the test pass for
      // the wrong reason (login returning 403 for a different cause).
      // The widened `string[]` cast dodges the literal-tuple
      // `includes` narrowing that would surface here as a compile
      // error if any future audit asks "is X in this list?" for an X
      // outside the list — fine for an assertion harness.
      expect((ADMIN_ROLE_NAMES as readonly string[]).includes('operations_manager')).toBe(true);

      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ status: 403, title: 'Forbidden' });
    });

    it('issues a session for a customer-facing grant without MFA', async () => {
      // Same shape as the admin test — same signup path, same login,
      // ONLY difference is the role name. Customer-facing roles
      // (family_payer per the catalog) are NOT in ADMIN_ROLE_NAMES so
      // the gate does not fire even when `mfa_enabled` is false.
      const email = uniqueEmail('non-admin-no-mfa');
      const { userId } = await signupActiveUser(email);

      await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });

      // Sanity for the inverse — family_payer is NOT in
      // ADMIN_ROLE_NAMES. Defends the structural-divergence claim.
      // Same widened-cast shape as the admin-side sanity check.
      expect((ADMIN_ROLE_NAMES as readonly string[]).includes('family_payer')).toBe(false);

      const result = await login(email);
      expect(result.status).toBe(200);
      expect(result.outcome).toBe('session');
    });

    it('the gate flips closed → open once an admin grant is revoked', async () => {
      // Defence-in-depth for the inverse: an admin-role holder
      // (operations_manager) whose grant is revoked must be able to
      // log in again without MFA — they're no longer staff. Without
      // this test, a regression that left the gate "sticky" (e.g. a
      // cached "admin status" check) would survive the revoke flow.
      const email = uniqueEmail('admin-revoked');
      const { userId } = await signupActiveUser(email);

      const { id: assignmentId } = await roleAssignments.grant({
        userId,
        roleName: 'finance',
        scope: { type: 'global' },
      });

      const blocked = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(blocked.status).toBe(403);

      await roleAssignments.revoke({ assignmentId });

      const allowed = await login(email);
      expect(allowed.status).toBe(200);
      expect(allowed.outcome).toBe('session');
      if (allowed.accessToken === null) {
        throw new Error('post-revoke login lacked access token');
      }
      // And the roles claim is now empty — the revoke propagated
      // into the fresh token.
      const context = verifyAccessToken(allowed.accessToken, {
        secret: jwtAccessSecret,
        algorithms: ['HS256'],
        issuer: jwtIssuer,
        audience: jwtAudience,
      });
      expect(context.roles).toEqual([]);
    });
  });

  describe('SSO enforcement gate against a real policy row (TS-296)', () => {
    /**
     * The SSO gate lives in `AuthService.issueSessionFor` — the single
     * session-minting choke point shared by the password-only login
     * and the MFA-verify path. Over plain HTTP an MFA-less admin is
     * refused by the admin-MFA gate BEFORE the SSO gate can fire, so
     * these cases drive `issueSessionFor` through the live DI graph
     * (exactly as `MfaController.verify` calls it after a completed
     * challenge) against a REAL `org_security_policies` row — proving
     * the policy lookup, the 'global' sentinel mapping, and the
     * `ssoAsserted` seam against real Postgres.
     */
    const SSO_ACTOR = {
      actorUserId: 'usr_integration_admin',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };

    it('refuses a session for a global-scoped admin once the global policy requires SSO', async () => {
      const [{ AuthService }, { OrgSecurityPolicyService }] = await Promise.all([
        import('../../src/modules/auth/services/auth.service'),
        import('../../src/modules/rbac/org-security-policy.service'),
      ]);
      const auth = app.get(AuthService);
      const policies = app.get(OrgSecurityPolicyService);

      const email = uniqueEmail('sso-gated-admin');
      const { userId } = await signupActiveUser(email);
      await roleAssignments.grant({
        userId,
        roleName: 'operations_manager',
        scope: { type: 'global' },
      });

      // Flip the global sentinel row on — a REAL upsert, which also
      // lands an audit.action_recorded row in identity.outbox_events.
      await policies.upsertPolicy({ scopeId: 'global', ssoRequired: true, actor: SSO_ACTOR });

      try {
        await expect(
          auth.issueSessionFor({
            userId,
            email,
            status: 'active',
            mfaVerified: true,
            ssoAsserted: false,
          }),
        ).rejects.toMatchObject({
          response: { status: 403, code: 'sso_assertion_required' },
        });

        // The seam: an SSO-asserted issuance (what the provider
        // integration will perform) passes the same gate.
        const asserted = await auth.issueSessionFor({
          userId,
          email,
          status: 'active',
          mfaVerified: true,
          ssoAsserted: true,
        });
        expect(asserted.outcome).toBe('session');

        // The policy mutation emitted a durable audit event (TS-295
        // invariant carried into TS-296).
        const outboxRows = await harnessPrisma.$queryRawUnsafe<Array<{ event_name: string }>>(
          `SELECT event_name FROM identity.outbox_events WHERE payload->>'action' LIKE 'org_security_policy:%'`,
        );
        expect(outboxRows.length).toBeGreaterThan(0);
        expect(outboxRows[0]?.event_name).toBe('audit.action_recorded');
      } finally {
        // Leave the sentinel off so sibling tests (and file re-runs
        // against a warm database) never inherit a locked-out state.
        await policies.upsertPolicy({ scopeId: 'global', ssoRequired: false, actor: SSO_ACTOR });
      }
    });

    it('does not gate a customer-facing (non-admin) session even with the policy on', async () => {
      const [{ AuthService }, { OrgSecurityPolicyService }] = await Promise.all([
        import('../../src/modules/auth/services/auth.service'),
        import('../../src/modules/rbac/org-security-policy.service'),
      ]);
      const auth = app.get(AuthService);
      const policies = app.get(OrgSecurityPolicyService);

      const email = uniqueEmail('sso-non-admin');
      const { userId } = await signupActiveUser(email);
      await roleAssignments.grant({
        userId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });

      await policies.upsertPolicy({ scopeId: 'global', ssoRequired: true, actor: SSO_ACTOR });
      try {
        const session = await auth.issueSessionFor({
          userId,
          email,
          status: 'active',
          mfaVerified: false,
          ssoAsserted: false,
        });
        expect(session.outcome).toBe('session');
      } finally {
        await policies.upsertPolicy({ scopeId: 'global', ssoRequired: false, actor: SSO_ACTOR });
      }
    });

    it('surfaces the stable mfa_enrollment_required code on the HTTP login gate', async () => {
      // The retrofit half of TS-296's error-code work: the admin-MFA
      // 403 now carries a machine-readable `code` the login UI
      // branches on instead of regexing the detail text.
      const email = uniqueEmail('mfa-code-check');
      const { userId } = await signupActiveUser(email);
      await roleAssignments.grant({
        userId,
        roleName: 'finance',
        scope: { type: 'global' },
      });

      const res = await callJson('/api/v1/auth/login', {
        body: { email, password: VALID_PASSWORD },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ status: 403, code: 'mfa_enrollment_required' });
    });
  });

  describe('impersonation lifecycle against real Postgres (TS-297)', () => {
    /**
     * Drives `AdminImpersonationService` through the live DI graph:
     * a real mint (session row + `actorOnBehalfOf` claim + in-tx
     * `user_impersonation:start` outbox event) followed by a real end
     * (family revoked + `:end` event) — the full identity-side
     * lifecycle over live Postgres. The admin-staff refusal is also
     * exercised against the seeded catalog.
     */
    const OPERATOR_ACTOR = (operatorUserId: string) => ({
      actorUserId: operatorUserId,
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    });

    it('mints, labels, audits, and ends an impersonation session', async () => {
      const { AdminImpersonationService } = await import(
        '../../src/modules/admin/services/admin-impersonation.service'
      );
      const impersonation = app.get(AdminImpersonationService);

      const operatorEmail = uniqueEmail('imp-operator');
      const { userId: operatorId } = await signupActiveUser(operatorEmail);
      const targetEmail = uniqueEmail('imp-target');
      const { userId: targetId } = await signupActiveUser(targetEmail);
      await roleAssignments.grant({
        userId: targetId,
        roleName: 'family_payer',
        scope: { type: 'global' },
      });

      const started = await impersonation.start({
        targetUserId: targetId,
        reason: 'integration: verify the full lifecycle',
        actor: OPERATOR_ACTOR(operatorId),
        operatorMfaVerified: true,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error('expected ok');

      // The token acts as the TARGET but carries the OPERATOR.
      const context = verifyAccessToken(started.value.accessToken, {
        secret: jwtAccessSecret,
        algorithms: ['HS256'],
        issuer: jwtIssuer,
        audience: jwtAudience,
      });
      expect(context.userId).toBe(targetId);
      expect(context.actorOnBehalfOf).toBe(operatorId);
      expect(context.mfaVerified).toBe(true);

      // The session row is marked with the operator.
      const rows = await harnessPrisma.refreshToken.findMany({
        where: { familyId: started.value.sessionFamilyId },
        select: { impersonatorUserId: true, revokedAt: true, expiresAt: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.impersonatorUserId === operatorId)).toBe(true);

      // The start event landed durably in the outbox, in-tx.
      const startEvents = await harnessPrisma.$queryRawUnsafe<
        Array<{ event_name: string; payload: { resourceId?: string } }>
      >(
        `SELECT event_name, payload FROM identity.outbox_events WHERE payload->>'action' = 'user_impersonation:start' AND payload->>'resourceId' = '${targetId}'`,
      );
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]?.event_name).toBe('audit.action_recorded');

      // End revokes the family and audits; a second end converges.
      const ended = await impersonation.end({
        sessionFamilyId: started.value.sessionFamilyId,
        actor: OPERATOR_ACTOR(operatorId),
      });
      expect(ended.ok).toBe(true);
      if (!ended.ok) throw new Error('expected ok');
      expect(ended.value.ended).toBe(true);

      const revoked = await harnessPrisma.refreshToken.findMany({
        where: { familyId: started.value.sessionFamilyId },
        select: { revokedAt: true },
      });
      expect(revoked.every((r) => r.revokedAt !== null)).toBe(true);

      const endEvents = await harnessPrisma.$queryRawUnsafe<Array<{ event_name: string }>>(
        `SELECT event_name FROM identity.outbox_events WHERE payload->>'action' = 'user_impersonation:end' AND payload->>'resourceId' = '${targetId}'`,
      );
      expect(endEvents).toHaveLength(1);

      const again = await impersonation.end({
        sessionFamilyId: started.value.sessionFamilyId,
        actor: OPERATOR_ACTOR(operatorId),
      });
      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error('expected ok');
      expect(again.value.ended).toBe(false);
    });

    it('refuses to impersonate an admin-staff account (seeded catalog)', async () => {
      const { AdminImpersonationService } = await import(
        '../../src/modules/admin/services/admin-impersonation.service'
      );
      const impersonation = app.get(AdminImpersonationService);

      const operatorEmail = uniqueEmail('imp-operator2');
      const { userId: operatorId } = await signupActiveUser(operatorEmail);
      const staffEmail = uniqueEmail('imp-staff-target');
      const { userId: staffId } = await signupActiveUser(staffEmail);
      await roleAssignments.grant({
        userId: staffId,
        roleName: 'trust_safety',
        scope: { type: 'global' },
      });

      const refused = await impersonation.start({
        targetUserId: staffId,
        reason: 'should be refused',
        actor: OPERATOR_ACTOR(operatorId),
        operatorMfaVerified: true,
      });
      expect(refused).toEqual({ ok: false, failure: { kind: 'admin_target' } });

      const events = await harnessPrisma.$queryRawUnsafe<Array<{ event_name: string }>>(
        `SELECT event_name FROM identity.outbox_events WHERE payload->>'action' = 'user_impersonation:start' AND payload->>'resourceId' = '${staffId}'`,
      );
      expect(events).toHaveLength(0);
    });
  });
});
