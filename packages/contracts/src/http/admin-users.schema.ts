import { z } from 'zod';

import { KycStatusSchema } from './kyc.schema';
import { MeRoleAssignmentSchema } from './gateway-me.schema';
import { UserStatusSchema } from './auth.schema';

/**
 * Admin users management HTTP DTOs (TS-126 Slice 1; PRD §10.2).
 *
 * Two read-only surfaces:
 *
 *   - `GET /api/v1/admin/users?q=&status=&roleName=&cursor=&limit=`
 *     Cursor-paginated search across the identity service's `users`
 *     table. Returns a denormalised summary per row (role-assignment
 *     count, MFA-enabled flag, lockout indicator) so the list page
 *     can render without an N+1 detail fetch.
 *
 *   - `GET /api/v1/admin/users/:id`
 *     Full account-detail view. Carries the user record plus role
 *     assignments (denormalised with permissions), confirmed MFA
 *     methods (kind + label + last-used), the most-recent KYC record
 *     (status + verifiedAt — no encrypted payload), and lockout state.
 *
 * **Slice 1 scope.** Read-only. Mutations (suspend / reinstate /
 * unlock — TS-025-followup-2), impersonation, KYC document review
 * queue, and background-check status surface arrive in later TS-126
 * follow-ups. Each deferred capability is captured as its own
 * `TS-126-followup-*` so the gates have named owners.
 *
 * **Authorisation.** The downstream service-identity endpoint is
 * gated by an `AdminRoleGuard` that requires the access token's
 * `roles[]` claim to carry an active `super_admin` assignment. The
 * api-gateway proxy enforces the same gate at the edge for
 * defence-in-depth (and to avoid serving any downstream call when
 * the caller is non-admin).
 *
 * **Audit.** Admin reads do NOT emit audit events in Slice 1 — only
 * mutations do, and Slice 1 has no mutations. Read auditing arrives
 * with TS-100 audit-svc when the pipe is operational.
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a
 * typo or stray field never silently round-trips.
 */

/**
 * Cursor max length. Opaque to the consumer; the service emits a
 * base64-encoded `(createdAt-ISO, id)` pair. 256 bytes is well past
 * the maximum encoded size; the cap exists to bound query-string
 * abuse, not to constrain the cursor format.
 */
export const ADMIN_USERS_LIST_CURSOR_MAX_LENGTH = 256;

/** Default page size for `GET /api/v1/admin/users`. */
export const ADMIN_USERS_LIST_LIMIT_DEFAULT = 25;

/** Maximum page size for `GET /api/v1/admin/users`. */
export const ADMIN_USERS_LIST_LIMIT_MAX = 100;

/**
 * Email-substring filter max length. Loose superset of the
 * RFC 5321 max (254) — the search is case-insensitive substring,
 * not exact-email, so the cap mostly bounds query-string abuse.
 */
export const ADMIN_USERS_LIST_QUERY_MAX_LENGTH = 254;

/**
 * Role-name filter max length. Matches `ME_ROLE_NAME_MAX_LENGTH` from
 * the gateway-me schema so the catalogs cannot drift.
 */
export const ADMIN_USERS_LIST_ROLE_NAME_MAX_LENGTH = 64;

/** User-id path-parameter max length. CUID2 + safety margin. */
export const ADMIN_USERS_USER_ID_MAX_LENGTH = 64;

/**
 * MFA method label max length. Matches the underlying
 * `mfa_methods.label` column policy (Optional human label per the
 * service-identity schema — no hard DB length cap, so the contract
 * picks a generous-but-bounded value).
 */
export const ADMIN_USERS_MFA_LABEL_MAX_LENGTH = 120;

/**
 * Kind discriminator for the MFA summary. Mirrors the
 * `MfaMethodKind` Postgres enum in service-identity exactly. We
 * deliberately do NOT re-export `MfaMethodKindSchema` from
 * `auth.schema` to avoid a circular wire-up if the auth schema is
 * later split — the discriminator is small and the two are unlikely
 * to drift in lock-step with anything else.
 */
const AdminUsersMfaKindSchema = z.enum(['totp', 'sms_backup']);

export const AdminUserMfaSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    kind: AdminUsersMfaKindSchema,
    /** Optional human label set by the user at enrolment time. */
    label: z.string().min(1).max(ADMIN_USERS_MFA_LABEL_MAX_LENGTH).nullable(),
    confirmedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminUserMfaSummary = z.infer<typeof AdminUserMfaSummarySchema>;

/**
 * Latest KYC snapshot for the detail view. Null when the user has
 * never started a KYC session. Drops the encrypted payload columns
 * (internal-only) — Slice 1's detail view shows only the status
 * trail. Full document review lands in a later follow-up.
 */
export const AdminUserKycSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    status: KycStatusSchema,
    verifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminUserKycSummary = z.infer<typeof AdminUserKycSummarySchema>;

/**
 * Lockout snapshot — surfaces the three TS-025 lockout columns so
 * ops can answer "is this account currently locked, and for how
 * long" without leaving the detail page.
 */
export const AdminUserLockoutSummarySchema = z
  .object({
    failedLoginCount: z.number().int().nonnegative(),
    lastFailedLoginAt: z.string().datetime().nullable(),
    /**
     * `lockedUntil` is the policy column; `currentlyLocked` is the
     * derived flag (`lockedUntil != null && lockedUntil > now()`
     * computed by the service). Carrying both lets the UI render
     * the deadline without re-computing the comparison.
     */
    lockedUntil: z.string().datetime().nullable(),
    currentlyLocked: z.boolean(),
  })
  .strict();
export type AdminUserLockoutSummary = z.infer<typeof AdminUserLockoutSummarySchema>;

/**
 * Row shape for the list response. Carries only what the list page
 * needs to render — full role / MFA / KYC graph is reserved for the
 * detail endpoint.
 */
export const AdminUserSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    email: z.string().min(1).max(ADMIN_USERS_LIST_QUERY_MAX_LENGTH),
    phone: z.string().min(1).max(64).nullable(),
    status: UserStatusSchema,
    mfaEnabled: z.boolean(),
    emailVerifiedAt: z.string().datetime().nullable(),
    /**
     * Number of ACTIVE role assignments (revokedAt null AND not
     * expired). Lets the list show "3 roles" without expanding the
     * graph.
     */
    activeRoleCount: z.number().int().nonnegative(),
    /**
     * Whether the user currently holds an admin-staff role per
     * `ADMIN_ROLE_NAMES`. Lets ops filter on / highlight staff.
     */
    holdsAdminRole: z.boolean(),
    /** Derived "is currently in a lockout window" flag. */
    currentlyLocked: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

/**
 * Query shape for `GET /api/v1/admin/users`.
 *
 * - `q`           — optional case-insensitive substring filter against
 *                   the email column. Trimmed by the service; empty
 *                   after trim → treated as omitted.
 * - `status`      — optional exact-match filter against `users.status`.
 * - `roleName`    — optional filter: include only users with an
 *                   ACTIVE assignment of the named role. Matches the
 *                   exact role name (system or custom).
 * - `cursor`      — opaque pagination cursor from the previous page's
 *                   `nextCursor`.
 * - `limit`       — page size; defaults to 25, max 100.
 */
export const AdminUsersListQuerySchema = z
  .object({
    q: z.string().min(1).max(ADMIN_USERS_LIST_QUERY_MAX_LENGTH).optional(),
    status: UserStatusSchema.optional(),
    roleName: z.string().min(1).max(ADMIN_USERS_LIST_ROLE_NAME_MAX_LENGTH).optional(),
    cursor: z.string().min(1).max(ADMIN_USERS_LIST_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_USERS_LIST_LIMIT_MAX)
      .default(ADMIN_USERS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type AdminUsersListQuery = z.infer<typeof AdminUsersListQuerySchema>;

export const AdminUsersListResponseSchema = z
  .object({
    users: z.array(AdminUserSummarySchema),
    nextCursor: z.string().min(1).max(ADMIN_USERS_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminUsersListResponse = z.infer<typeof AdminUsersListResponseSchema>;

/**
 * Detail-view response for `GET /api/v1/admin/users/:id`.
 *
 * Reuses `MeRoleAssignmentSchema` from `gateway-me` so the
 * role-assignment shape on the admin surface matches what the
 * portal's `/me` endpoint returns. Same denormalised shape (name +
 * permissions + scope + optional expiresAt) — only the source
 * differs (admin reads any user; `/me` reads the caller).
 */
export const AdminUserDetailSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    email: z.string().min(1).max(ADMIN_USERS_LIST_QUERY_MAX_LENGTH),
    phone: z.string().min(1).max(64).nullable(),
    status: UserStatusSchema,
    mfaEnabled: z.boolean(),
    emailVerifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
    /**
     * Active role assignments only (revokedAt null AND not expired).
     * The admin detail view does not surface revoked / expired
     * assignments in Slice 1; full history arrives with the RBAC
     * admin tooling (TS-290).
     */
    roles: z.array(MeRoleAssignmentSchema),
    /** Holds at least one active admin-staff role. */
    holdsAdminRole: z.boolean(),
    /**
     * Confirmed (and not soft-deleted) MFA methods. Unconfirmed /
     * deleted methods are filtered server-side.
     */
    mfaMethods: z.array(AdminUserMfaSummarySchema),
    /** Most-recent KYC record (any status); null if none ever started. */
    latestKyc: AdminUserKycSummarySchema.nullable(),
    lockout: AdminUserLockoutSummarySchema,
  })
  .strict();
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

export const AdminUserDetailResponseSchema = z
  .object({
    user: AdminUserDetailSchema,
  })
  .strict();
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;
