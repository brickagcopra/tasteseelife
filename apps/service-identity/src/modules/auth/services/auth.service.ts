import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ADMIN_ROLE_NAMES, isAdminRoleName } from '@taste-and-see/auth-sdk';
import {
  AUTH_GATE_PROBLEM_CODE,
  ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID,
  type LoginChallengeResponse,
  type LoginRequest,
  type LoginSessionResponse,
  type SignupRequest,
  type SignupResponse,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { OrgSecurityPolicyService } from '../../rbac/org-security-policy.service';
import { RoleAssignmentService } from '../../rbac/role-assignment.service';
import { toSignupResponse } from '../mappers/user.mapper';
import { EmailVerificationService } from './email-verification.service';
import { IpCircuitBreakerService } from './ip-circuit-breaker.service';
import { LockoutService } from './lockout.service';
import { MfaChallengeTokenService } from './mfa-challenge-token.service';
import { PasswordHasherService } from './password-hasher.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

/**
 * Narrow `unknown` errors thrown by Prisma to its `KnownRequestError`
 * shape via duck typing, without taking a hard dependency on the
 * generated namespace's value side. The Prisma 5.x generated types
 * declare `Prisma.PrismaClientKnownRequestError` inside a namespace
 * via `export import` — that pattern is fragile under
 * `noUncheckedIndexedAccess` / `verbatimModuleSyntax` permutations
 * and resolves inconsistently across editor/CLI builds. The duck-
 * typed guard below is equivalent for our purposes (we only ever read
 * `.code` and `.meta.target`) and keeps the surface minimal.
 *
 * Codes we care about for now:
 *   P2002 — unique constraint violation
 */
interface PrismaKnownRequestError {
  readonly code: string;
  readonly meta?: { readonly target?: readonly string[] };
}

function isPrismaKnownRequestError(err: unknown): err is PrismaKnownRequestError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string';
}

/**
 * A bcrypt-shaped digest produced against a never-issued password. Used
 * as a constant-cost decoy on the user-not-found path so the response
 * time profile of "no such email" matches "wrong password", defeating
 * trivial timing oracles for account enumeration. The exact value
 * doesn't matter — `bcrypt.compare()` will run the same number of
 * rounds against any well-formed cost-12 digest.
 *
 * Format: `$2b$12$<22-char-salt><31-char-hash>`.
 */
const DUMMY_BCRYPT_DIGEST = '$2b$12$abcdefghijklmnopqrstuuKzfXJU1A./X.5Mwd0VPm.rvYzqM9zWG';

/**
 * Result of a successful credential check.
 *
 * Two-branch discriminated union mirrors the wire-level
 * `LoginResponseSchema` discriminated union (`outcome: 'session' |
 * 'challenge'`):
 *
 *   - `outcome: 'session'` — the user has no MFA configured (or just
 *     completed one via `/api/v1/auth/mfa/verify`). Carries the
 *     access-token JSON body PLUS the raw refresh token (which the
 *     controller writes into a `Set-Cookie` header). Splitting the
 *     two keeps the `LoginSessionResponse` contract tight (no token
 *     in the body) without forcing the controller to re-issue the
 *     session just to get the cookie value.
 *
 *   - `outcome: 'challenge'` — credentials valid AND user has at
 *     least one confirmed MFA method. The body carries only the
 *     short-lived challenge token; the refresh cookie is NOT
 *     emitted on this branch (a refresh cookie before MFA passes
 *     would defeat the second factor).
 */
export type LoginResult =
  | {
      readonly outcome: 'session';
      readonly response: LoginSessionResponse;
      readonly refreshToken: string;
      readonly refreshExpiresAt: Date;
    }
  | {
      readonly outcome: 'challenge';
      readonly response: LoginChallengeResponse;
    };

/**
 * Authentication domain service for service-identity.
 *
 * Logic lives here, not in the controller (CLAUDE.md §2.3: "controllers
 * orchestrate, services own logic"). The repository / persistence layer
 * is `PrismaService` directly — service-identity's tables are simple
 * enough that an additional UserRepository abstraction would be premature
 * at this scale; if/when row-level concerns multiply we extract one.
 *
 * Surface so far: `signup()` (TS-021), `login()` (TS-022, with MFA
 * branch from TS-023 and RBAC propagation from TS-024 and per-user
 * lockout from TS-025). KYC (TS-026) extends this surface next.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasherService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly mfaChallengeTokens: MfaChallengeTokenService,
    private readonly roleAssignments: RoleAssignmentService,
    private readonly orgSecurityPolicies: OrgSecurityPolicyService,
    private readonly lockout: LockoutService,
    private readonly ipCircuitBreaker: IpCircuitBreakerService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /**
   * Create a new user account in `pending_verification` status.
   *
   * Behaviour notes:
   *  - Email is normalised to lower-case before hashing/persistence so
   *    `Alice@x.com` and `alice@x.com` collide as duplicates. The
   *    Prisma `email` column is unique (TS-020 schema), so the database
   *    is the authoritative dedup boundary.
   *  - Phone, when present, is stored as-given. The contract already
   *    constrained the format to E.164.
   *  - `status` is `pending_verification`, and TS-510's
   *    `POST /api/v1/auth/verify-email` is what flips it to `active`.
   *    The token is minted **inside this transaction**, together with the
   *    `identity.email_verification_requested` outbox event that delivers
   *    it (CLAUDE.md §5.3): a committed signup therefore always has a way
   *    to verify, and a rolled-back one mails nobody. Until TS-510 landed
   *    there was no such flip anywhere, so every account signup created
   *    was permanently unable to log in.
   *  - On a unique-violation collision (P2002) we throw 409 Conflict
   *    with a generic message — we deliberately do NOT echo "email
   *    already exists" because that's an account-enumeration oracle
   *    (CLAUDE.md §3.1 spirit). The message is generic; the trace log
   *    carries the constraint name for support diagnostics.
   *
   * Returns the mapped `SignupResponse` DTO, never a raw Prisma row.
   */
  async signup(input: SignupRequest): Promise<SignupResponse> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await this.hasher.hash(input.password);

    try {
      // Project only the columns the mapper needs. `passwordHash`,
      // `deletedAt`, `mfaEnabled`, `updatedAt`, `emailVerifiedAt` are
      // intentionally left off — defence in depth so a future widening
      // of the response DTO needs an explicit `select` change here.
      const user = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const created = await tx.user.create({
          data: {
            email,
            phone: input.phone ?? null,
            passwordHash,
            // status defaults to `pending_verification` per Prisma model.
          },
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            createdAt: true,
          },
        });

        await this.emailVerification.issueForSignup(tx, {
          id: created.id,
          email: created.email,
        });

        return created;
      });

      this.logger.log({ userId: user.id, status: user.status }, 'signup completed');
      return toSignupResponse(user);
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        // P2002 = unique constraint violation. `meta.target` carries the
        // failing column name(s) — we log it for support, but the client
        // sees a generic message to avoid account-enumeration leakage.
        this.logger.warn(
          { constraint: err.meta?.target, code: err.code },
          'signup conflict — unique violation',
        );
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'An account with the supplied identifier already exists.',
        });
      }
      throw err;
    }
  }

  /**
   * Authenticate a user, mint a 15-minute access token, and issue a
   * fresh refresh-token family.
   *
   * Security properties:
   *  - **Single 401 outcome.** Both "no such email" and "wrong password"
   *    return the exact same exception body — never "user not found" or
   *    "invalid password" (account enumeration). The status code is
   *    identical and the detail string is generic.
   *  - **Constant-cost path on user-not-found.** When no row exists we
   *    still run a bcrypt verification against `DUMMY_BCRYPT_DIGEST` so
   *    the response-time profile of "no such email" matches "wrong
   *    password". Bcrypt's compare is not perfectly constant-time across
   *    digests, but the dominant cost (the cost-12 work factor) is the
   *    same — closing the easy timing oracle.
   *  - **Status gating.** Only `active` accounts can log in. Other
   *    statuses (`pending_verification`, `suspended`, `deactivated`)
   *    yield the same generic 401 — we deliberately don't expose
   *    "your account is suspended" because that's enumeration-equivalent.
   *    A future "send verification email" surface ships with TS-026.
   *  - **Soft-delete gating.** Rows with `deleted_at != null` cannot log
   *    in even if they remain on disk for legal retention.
   *  - **Per-user lockout (TS-025).** Each consecutive failed attempt
   *    increments a counter on the users row; from the third failure
   *    onward an exponential-backoff window writes `locked_until`.
   *    While `locked_until` is in the future even a correct password
   *    yields a generic 401 — same shape as the bad-password path so
   *    the lockout state itself is not an oracle. A successful login
   *    clears the counter.
   *  - **IP circuit breaker (TS-025-followup-1).** A Redis-backed
   *    sliding-window counter per source IP × `/login` trips at a
   *    higher threshold than any single user's per-user gate (default
   *    30 failures in 5 min). Once tripped, every subsequent login
   *    attempt from that IP returns the same generic 401 — the
   *    breaker state itself is not enumerable. The breaker is
   *    checked BEFORE the user lookup so a tripped IP burns no
   *    bcrypt cycles, no DB read, no role lookup. Failure-counting
   *    is broader than the per-user gate: ALL credential-failure
   *    branches (no-user, soft-deleted, inactive-status, bad-
   *    password) increment the IP bucket so a credential-stuffer
   *    probing many accounts can't dodge the breaker by hitting the
   *    no-user branch. Fails open on a Redis outage (CLAUDE.md §4.3).
   */
  async login(
    input: LoginRequest,
    context: { readonly ip?: string | undefined; readonly userAgent?: string | undefined } = {},
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();

    // IP circuit breaker (TS-025-followup-1). Checked BEFORE the user
    // lookup so a tripped IP short-circuits the whole authentication
    // path — no bcrypt cycles, no DB read, no role lookup. Returns
    // the same generic 401 as bad-password so the breaker state is
    // never an enumeration oracle. We deliberately do NOT increment
    // the bucket on the blocked path — the breaker is already
    // tripped, and double-counting just keeps the lock open longer
    // than the window the operator configured. Fails open on a
    // Redis outage (per the service's documented posture); the per-
    // user `LockoutService` stays authoritative as the second layer.
    if (await this.ipCircuitBreaker.checkBlocked(context.ip)) {
      this.logger.debug(
        { ip: context.ip, email },
        'login blocked — IP circuit breaker tripped (rendered to client as generic 401)',
      );
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        mfaEnabled: true,
        lockedUntil: true,
      },
    });

    let passwordOk = false;
    if (user === null) {
      // Burn the same bcrypt cycles regardless so timing differs only by
      // the (small) DB-miss savings. Result is deliberately ignored.
      await this.hasher.verify(input.password, DUMMY_BCRYPT_DIGEST);
    } else {
      passwordOk = await this.hasher.verify(input.password, user.passwordHash);
    }

    if (user === null || user.deletedAt !== null || user.status !== 'active' || !passwordOk) {
      const failureReason: 'no-user' | 'soft-deleted' | 'inactive-status' | 'bad-password' =
        user === null
          ? 'no-user'
          : user.deletedAt !== null
            ? 'soft-deleted'
            : user.status !== 'active'
              ? 'inactive-status'
              : 'bad-password';

      // Record the failure only when (a) we have a real user row and
      // (b) the failure is specifically wrong-password. Recording on
      // the no-user / soft-deleted / inactive-status branches is
      // either impossible (no userId) or actively harmful (a typo'd
      // email would punish a different account). The wrong-password
      // branch is the one the schedule was designed to defend
      // against — a determined attacker probing real passwords.
      if (user !== null && failureReason === 'bad-password') {
        // Awaited so the write commits before the response goes out;
        // an unawaited fire-and-forget would silently drop the
        // increment under shutdown. The cost is one indexed UPDATE
        // — well within the login latency budget.
        await this.lockout.recordFailure(user.id);
      }

      // IP circuit breaker (TS-025-followup-1) — increment on EVERY
      // credential-failure branch. The attacker doesn't know which
      // branch their probe hit, so the breaker shouldn't either —
      // otherwise a credential-stuffer probing many usernames would
      // hit the no-user branch repeatedly and bypass the breaker.
      // Unlike the per-user lockout above (which is scoped to a real
      // user row), the IP layer is purely about cross-account
      // probing volume from one source. Fire-and-forget on errors
      // per the service's documented fail-open posture; the call
      // itself is awaited so the increment commits before the
      // response goes out.
      await this.ipCircuitBreaker.recordFailure(context.ip);

      // Debug-level only — info-level login-failure logs that include the
      // email would be a low-effort PII enumeration tool against the log
      // pipeline (CLAUDE.md §3.9). Debug runs in dev / staging only.
      this.logger.debug(
        { email, failureReason },
        'login failed (rendered to client as generic 401)',
      );
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      });
    }

    // Lockout gate (TS-025). Credentials are valid, but if the
    // `locked_until` deadline is still in the future we refuse to
    // issue a session. The 401 body is identical to the bad-password
    // body so an observer cannot distinguish "lockout active" from
    // "wrong password" — closing the lockout-state oracle. We do
    // NOT record an additional failure here: the user is already
    // locked, and the schedule has already done its work.
    if (this.lockout.isLocked(user.lockedUntil)) {
      this.logger.debug(
        { userId: user.id, lockedUntil: user.lockedUntil?.toISOString() },
        'login blocked — lockout active (rendered to client as generic 401)',
      );
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      });
    }

    // Credentials valid and no active lockout — clear any stale
    // counter from earlier mistypes before the gates below. The
    // clear is idempotent on a clean account (no prior failures →
    // a no-op write). Running this BEFORE the admin-MFA gate means
    // an admin whose login was being challenged on the MFA gate
    // still gets their failure counter reset — but a 403 on the
    // gate does NOT consume the lock (the gate is a precondition
    // for issuing a session, not an authentication failure).
    await this.lockout.recordSuccess(user.id);

    // Admin-MFA gate (TS-023-followup-1; CLAUDE.md §3.1 — "MFA
    // mandatory for all admin staff"). Credentials are valid AND
    // mfa_enabled is false; if this user holds any admin-staff role
    // (PDD §10.2), we refuse to issue a session. The check runs
    // before the MFA branch decision so the gate is consistent
    // regardless of whether the user has MFA partially enrolled —
    // mfa_enabled is the authoritative bit.
    //
    // Note: a user whose mfa_enabled is TRUE always falls into the
    // challenge branch below, so this gate only ever fires on the
    // "admin role + no MFA" combination. Skipping the lookup when
    // mfa_enabled is true keeps the common path single-query.
    //
    // Bootstrap flow caveat: the only way to enrol MFA today is via
    // `POST /auth/mfa/totp/enroll`, which requires an authenticated
    // session. A user granted an admin role BEFORE enrolling MFA
    // will be locked out by this gate; the runbook is to enrol MFA
    // first, then promote. A future "admin enrolment magic link"
    // surface (captured as TS-023-followup-1a) closes that gap.
    if (!user.mfaEnabled) {
      const isAdmin = await this.roleAssignments.holdsAnyRole(user.id, ADMIN_ROLE_NAMES);
      if (isAdmin) {
        // Logged at warn level so ops can correlate without leaking
        // the trigger to the client. The user-facing detail is
        // generic + actionable; we deliberately don't echo the role
        // names in the response body.
        this.logger.warn({ userId: user.id }, 'login refused — admin staff role without MFA');
        throw new ForbiddenException({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          // Machine-readable discriminator (TS-296) — the login UI
          // branches on `code`, never on the human-facing detail.
          code: AUTH_GATE_PROBLEM_CODE.mfaEnrollmentRequired,
          detail:
            'Multi-factor authentication is required for this account. Please complete enrollment to continue.',
        });
      }
    }

    // MFA branch — credentials valid, but the user has MFA enabled.
    // Issue a short-lived challenge token instead of a session;
    // refresh cookie is NOT emitted here (the controller only writes
    // it on the `outcome: 'session'` branch).
    if (user.mfaEnabled) {
      const challenge = await this.mfaChallengeTokens.issue({
        userId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
      });
      this.logger.log(
        { userId: user.id, jti: challenge.jti },
        'login succeeded — MFA challenge issued',
      );
      return {
        outcome: 'challenge',
        response: {
          outcome: 'challenge',
          challengeToken: challenge.token,
          expiresIn: challenge.expiresInSeconds,
        },
      };
    }

    return this.issueSessionFor({
      userId: user.id,
      email: user.email,
      status: user.status,
      mfaVerified: false,
      ssoAsserted: false,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Mint a session — extracted from `login()` so the MFA verify
   * surface (`MfaController.verify`) can call the same code path
   * after consuming a challenge. The single source of truth means
   * "what does login emit on success" cannot drift between the
   * password-only path and the MFA-completed path.
   *
   * **SSO gate (TS-296; CLAUDE.md §3.1).** Placed HERE — not in
   * `login()` — because this is the only place sessions are minted;
   * a gate in `login()` alone would be bypassable via the MFA-verify
   * path. `ssoAsserted` is per-session state (like `mfaVerified`):
   * every caller passes `false` today — the seam the SSO
   * provider-integration sibling task will satisfy after validating
   * an IdP assertion. The gate runs BEFORE the refresh session is
   * persisted so a refusal never leaves an orphaned session family.
   */
  async issueSessionFor(args: {
    readonly userId: string;
    readonly email: string;
    readonly status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
    readonly mfaVerified: boolean;
    readonly ssoAsserted: boolean;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
    /**
     * TS-297: present ONLY when the admin impersonation surface mints a
     * session in the target user's name. `operatorUserId` becomes the
     * access token's `actorOnBehalfOf` claim + the refresh rows'
     * `impersonator_user_id`; `sessionExpiresAt` caps the family far
     * below the ordinary refresh TTL; `tx` runs the session insert
     * inside the caller's transaction so it commits atomically with the
     * `user_impersonation:start` audit event. The SSO gate below still
     * runs against the TARGET's roles — impersonation targets can never
     * hold admin-staff roles (the impersonation service refuses them),
     * so the gate naturally skips; the OPERATOR's own login already
     * cleared their org's policy.
     */
    readonly impersonation?:
      | {
          readonly operatorUserId: string;
          readonly sessionExpiresAt: Date;
          readonly tx?: { readonly refreshToken: PrismaService['refreshToken'] } | undefined;
        }
      | undefined;
  }): Promise<Extract<LoginResult, { outcome: 'session' }> & { readonly sessionFamilyId: string }> {
    const roles = await this.roleAssignments.getActiveAssignments(args.userId);

    // SSO gate — admin-staff assignments only. A tenant-scoped admin
    // role is governed by its tenant's policy row; a global-scoped
    // one by the well-known 'global' sentinel row. Household-scoped
    // assignments are never admin-staff and are not gated. The
    // policy lookup is skipped entirely on the common non-admin path.
    if (!args.ssoAsserted) {
      const adminScopeIds = new Set<string>();
      for (const role of roles) {
        if (!isAdminRoleName(role.name)) continue;
        if (role.scope.type === 'global') {
          adminScopeIds.add(ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID);
        } else if (role.scope.type === 'tenant') {
          adminScopeIds.add(role.scope.tenantId);
        }
      }
      if (adminScopeIds.size > 0) {
        const ssoRequired = await this.orgSecurityPolicies.ssoRequiredForScopes([...adminScopeIds]);
        if (ssoRequired) {
          // Warn level so ops can correlate refused staff logins
          // without leaking the trigger to the client.
          this.logger.warn(
            { userId: args.userId, scopeIds: [...adminScopeIds] },
            'session refused — org policy requires SSO assertion for admin staff',
          );
          throw new ForbiddenException({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            code: AUTH_GATE_PROBLEM_CODE.ssoAssertionRequired,
            detail:
              'Your organization requires single sign-on for this account. Please sign in through your organization, or contact your administrator.',
          });
        }
      }
    }

    const session = await this.refreshTokenService.issueNewSession({
      userId: args.userId,
      ip: args.ip,
      userAgent: args.userAgent,
      ...(args.impersonation !== undefined && {
        expiresAt: args.impersonation.sessionExpiresAt,
        impersonatorUserId: args.impersonation.operatorUserId,
        tx: args.impersonation.tx,
      }),
    });
    const access = this.tokenService.signAccessToken({
      userId: args.userId,
      sessionId: session.familyId,
      mfaVerified: args.mfaVerified,
      ...(args.impersonation !== undefined && {
        actorOnBehalfOf: args.impersonation.operatorUserId,
      }),
      roles,
    });

    this.logger.log(
      {
        userId: args.userId,
        familyId: session.familyId,
        mfaVerified: args.mfaVerified,
        roleCount: roles.length,
        ...(args.impersonation !== undefined && {
          impersonatorUserId: args.impersonation.operatorUserId,
        }),
      },
      args.impersonation !== undefined ? 'impersonation session issued' : 'session issued',
    );

    return {
      outcome: 'session',
      response: {
        outcome: 'session',
        accessToken: access.token,
        tokenType: 'Bearer',
        expiresIn: access.expiresInSeconds,
        user: {
          id: args.userId,
          email: args.email,
          status: args.status,
        },
      },
      refreshToken: session.rawRefreshToken,
      refreshExpiresAt: session.expiresAt,
      // Additive: the refresh-family id (= the token's `sid` claim).
      // Login callers ignore it; the impersonation surface (TS-297)
      // returns it so the session can be ended by family.
      sessionFamilyId: session.familyId,
    };
  }
}
