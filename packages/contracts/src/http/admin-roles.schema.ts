import { z } from 'zod';

/**
 * Admin RBAC role-catalog HTTP DTOs (TS-290; PRD §10.12; PDD §10.3).
 *
 * The role-DEFINITION management surface — distinct from role
 * ASSIGNMENT (granting a role to a user, TS-292). Exposed by
 * service-identity and proxied by the api-gateway at the same paths:
 *
 *   - `GET   /api/v1/admin/permissions`
 *     Flat list of every permission in the catalog. Grouping by
 *     resource is a UI concern (TS-291 permission picker) — the wire
 *     shape stays flat and bounded.
 *
 *   - `GET   /api/v1/admin/roles`            (?includeArchived=true)
 *     Every role with its permission strings inline (the role-builder
 *     matrix renders from the list without an N+1 fetch). Archived
 *     roles are excluded unless `includeArchived` is set.
 *
 *   - `GET   /api/v1/admin/roles/:roleId`    — detail
 *   - `POST  /api/v1/admin/roles`            — create custom role
 *   - `PATCH /api/v1/admin/roles/:roleId`    — partial update
 *   - `POST  /api/v1/admin/roles/:roleId/archive`
 *
 * **System roles are read-only.** `isSystem: true` rows come from the
 * seed catalog (PDD §10.2 / Appendix B); mutating or archiving one is
 * rejected server-side with 409. The flag rides every record so the
 * UI can render the matrix read-only without a second fetch.
 *
 * **Archive, not delete.** Roles are never hard-deleted — user_roles
 * history rows FK them. `archivedAt` set means the role is hidden
 * from assignment surfaces; existing assignments keep working until
 * revoked (deactivation of holders is an operator decision, not a
 * cascade).
 *
 * **Authorisation.** Reads gate on `rbac:read`, mutations on
 * `rbac:write` (seeded to `super_admin`; `rbac:read` additionally to
 * `read_only_auditor`). Enforced by `PermissionGuard` at both the
 * gateway and service-identity (defence-in-depth).
 *
 * **`.strict()`** everywhere — unknown fields are a parse error.
 */

/** Max length of a role name. Mirrors the system-role naming style. */
export const ADMIN_ROLES_NAME_MAX_LENGTH = 64;

/** Max length of a role description. */
export const ADMIN_ROLES_DESCRIPTION_MAX_LENGTH = 500;

/** Max length of a role id path param (CUID-sized with headroom). */
export const ADMIN_ROLES_ROLE_ID_MAX_LENGTH = 64;

/** Max length of a single `resource:action` permission string. */
export const ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH = 128;

/**
 * Max permissions attachable to one role. The catalog is small (tens
 * of entries today); the bound defeats accidental megabyte payloads,
 * not a real product limit.
 */
export const ADMIN_ROLES_PERMISSIONS_MAX = 200;

/**
 * Max roles / permissions returned by the list endpoints. The role
 * catalog is operator-curated and small — offset/cursor pagination is
 * deliberately omitted (CLAUDE.md §5.1 allows offset only for stable
 * admin tables; a bounded single page is simpler still).
 */
export const ADMIN_ROLES_LIST_MAX = 1000;

/**
 * Role names follow the system-role idiom: lower snake_case, leading
 * letter (`super_admin`, `concierge_lead`). Keeps custom roles
 * consistent with seeded ones in token claims and audit lines.
 */
export const ADMIN_ROLES_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `resource:action` permission string (CLAUDE.md §2.2), e.g.
 * `subscription:write`, `accounting:close_period`.
 */
export const ADMIN_ROLES_PERMISSION_STRING_PATTERN = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

const RoleNameSchema = z
  .string()
  .min(1)
  .max(ADMIN_ROLES_NAME_MAX_LENGTH)
  .regex(ADMIN_ROLES_NAME_PATTERN, 'role name must be lower snake_case starting with a letter');

const RoleDescriptionSchema = z.string().min(1).max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH);

const PermissionStringSchema = z
  .string()
  .min(1)
  .max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH)
  .regex(ADMIN_ROLES_PERMISSION_STRING_PATTERN, 'permission must be a resource:action string');

/**
 * De-duplicated, bounded permission-string set as accepted on writes.
 * Duplicates are a client bug — reject loudly rather than silently
 * collapse.
 */
const PermissionStringSetSchema = z
  .array(PermissionStringSchema)
  .max(ADMIN_ROLES_PERMISSIONS_MAX)
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'permissions must not contain duplicates',
  });

// ─── Permission catalog (read-only) ─────────────────────────────────────

/**
 * One catalog permission. `resource` + `action` are the canonical
 * pair; `description` is the operator-facing copy the seed catalog
 * carries. The UI derives the `resource:action` string via
 * `${resource}:${action}` — it is deliberately not duplicated on the
 * wire.
 */
export const AdminPermissionRecordSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ROLES_ROLE_ID_MAX_LENGTH),
    resource: z.string().min(1).max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH),
    action: z.string().min(1).max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH),
    description: z.string().max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminPermissionRecord = z.infer<typeof AdminPermissionRecordSchema>;

/** Response body for `GET /api/v1/admin/permissions`. */
export const AdminPermissionsListResponseSchema = z
  .object({
    permissions: z.array(AdminPermissionRecordSchema).max(ADMIN_ROLES_LIST_MAX),
  })
  .strict();
export type AdminPermissionsListResponse = z.infer<typeof AdminPermissionsListResponseSchema>;

// ─── Role records ────────────────────────────────────────────────────────

/**
 * One role with its permission strings inline. `permissions` carries
 * canonical `resource:action` strings sorted server-side so diffs
 * (TS-291) are stable. `archivedAt` is null for live roles.
 */
export const AdminRoleRecordSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_ROLES_ROLE_ID_MAX_LENGTH),
    name: RoleNameSchema,
    description: z.string().max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH).nullable(),
    isSystem: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
    permissions: z.array(PermissionStringSchema).max(ADMIN_ROLES_PERMISSIONS_MAX),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminRoleRecord = z.infer<typeof AdminRoleRecordSchema>;

/**
 * Query for `GET /api/v1/admin/roles`. `includeArchived` opts in to
 * archived rows (repo idiom: `z.coerce.boolean()` — the UI only sends
 * the param when it wants archived rows included).
 */
export const AdminRolesListQuerySchema = z
  .object({
    includeArchived: z.coerce.boolean().optional(),
  })
  .strict();
export type AdminRolesListQuery = z.infer<typeof AdminRolesListQuerySchema>;

/** Response body for `GET /api/v1/admin/roles`. */
export const AdminRolesListResponseSchema = z
  .object({
    roles: z.array(AdminRoleRecordSchema).max(ADMIN_ROLES_LIST_MAX),
  })
  .strict();
export type AdminRolesListResponse = z.infer<typeof AdminRolesListResponseSchema>;

/**
 * Role envelope (`{ role }`) returned by detail, create, update, and
 * archive. Forward-compatible with side-data (assignment counts,
 * change history) without a v1 break.
 */
export const AdminRoleResponseSchema = z.object({ role: AdminRoleRecordSchema }).strict();
export type AdminRoleResponse = z.infer<typeof AdminRoleResponseSchema>;

// ─── Mutations ───────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/roles` body. Creates a CUSTOM role
 * (`isSystem: false` always — the flag is not accepted on the wire).
 * Every permission string must exist in the catalog; unknown strings
 * are rejected with a 400 naming the offenders. An empty permission
 * set is legal (roles can be shells pending TS-291 picker edits).
 */
export const CreateAdminRoleRequestSchema = z
  .object({
    name: RoleNameSchema,
    description: RoleDescriptionSchema.optional(),
    permissions: PermissionStringSetSchema,
  })
  .strict();
export type CreateAdminRoleRequest = z.infer<typeof CreateAdminRoleRequestSchema>;

/**
 * `PATCH /api/v1/admin/roles/:roleId` body — partial update mirroring
 * the content PATCH idiom: omitted fields are untouched, a supplied
 * `description: null` CLEARS it, `permissions` (when present)
 * REPLACES the whole set atomically. At least one field must be
 * supplied. Rejected with 409 for system or archived roles.
 */
export const UpdateAdminRoleRequestSchema = z
  .object({
    name: RoleNameSchema.optional(),
    description: RoleDescriptionSchema.nullable().optional(),
    permissions: PermissionStringSetSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.permissions !== undefined,
    { message: 'at least one field (name, description, permissions) must be supplied' },
  );
export type UpdateAdminRoleRequest = z.infer<typeof UpdateAdminRoleRequestSchema>;

/**
 * `POST /api/v1/admin/roles/:roleId/archive` body. The action is
 * mechanical (set `archivedAt`); an optional free-text `note` rides
 * the audit trail. Archiving an already-archived role is a 409, a
 * system role a 409, unknown a 404.
 */
export const ArchiveAdminRoleRequestSchema = z
  .object({
    note: z.string().min(1).max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type ArchiveAdminRoleRequest = z.infer<typeof ArchiveAdminRoleRequestSchema>;
