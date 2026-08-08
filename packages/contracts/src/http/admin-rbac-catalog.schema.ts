import { z } from 'zod';

import {
  ADMIN_ROLES_DESCRIPTION_MAX_LENGTH,
  ADMIN_ROLES_LIST_MAX,
  ADMIN_ROLES_NAME_MAX_LENGTH,
  ADMIN_ROLES_NAME_PATTERN,
  ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH,
  ADMIN_ROLES_PERMISSION_STRING_PATTERN,
  ADMIN_ROLES_PERMISSIONS_MAX,
} from './admin-roles.schema';

/**
 * Portable RBAC catalog envelope (TS-299; PRD §10.12; PDD §10.3).
 *
 * The cross-environment export/import format for the role + permission
 * catalog — dev / staging / prod parity when ops adds new roles. The
 * envelope is deliberately id-free and timestamp-free (beyond a single
 * provenance stamp): permissions are identified by their canonical
 * `(resource, action)` pair and roles by `name`, because surrogate ids
 * are meaningless across environments.
 *
 * Surfaces:
 *   - `GET /api/v1/admin/rbac-catalog/export` (service-identity +
 *     gateway proxy, `rbac:read`) returns this envelope.
 *   - The `rbac:catalog` CLI (`apps/service-identity/src/scripts/
 *     rbac-catalog.ts`) writes/reads the same envelope for `export` /
 *     `import`. Import is DELIBERATELY CLI-only — a bulk catalog
 *     mutation that can touch system roles is an ops workflow (K8s Job
 *     / operator shell), not an HTTP endpoint.
 *
 * Semantics an importer must honor (enforced service-side):
 *   - Upsert-by-natural-key, never delete. Roles/permissions present
 *     in the target but absent from the envelope are WARNINGS.
 *   - `isSystem` is authoritative from the TARGET (or, for new roles,
 *     from the auth-sdk `SYSTEM_ROLE_NAMES` list) — a file claiming
 *     `isSystem: true` for an unrecognised role name is refused.
 *   - Changes to system / sensitive roles are refused unless the
 *     operator passes an explicit allow flag.
 *
 * `formatVersion` is a literal so a future v2 envelope fails parsing
 * loudly instead of half-applying. **`.strict()` everywhere.**
 */

/** The only envelope version this schema parses. Bump = new schema. */
export const RBAC_CATALOG_FORMAT_VERSION = 1;

/**
 * One portable permission definition. `description` is nullable to
 * round-trip target rows whose description was never set.
 */
export const RbacCatalogPermissionSchema = z
  .object({
    resource: z.string().min(1).max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH),
    action: z.string().min(1).max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH),
    description: z.string().max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH).nullable(),
  })
  .strict();
export type RbacCatalogPermission = z.infer<typeof RbacCatalogPermissionSchema>;

/**
 * One portable role definition. `permissions` carries canonical
 * `resource:action` strings (sorted server-side on export for stable
 * diffs). `isSystem` is emitted so an importer knows which roles are
 * seed-owned — but it is never import-driven (see module doc).
 * Archived roles are env-state, not catalog definition — they are
 * excluded from exports and this schema deliberately has no
 * `archivedAt`.
 */
export const RbacCatalogRoleSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(ADMIN_ROLES_NAME_MAX_LENGTH)
      .regex(ADMIN_ROLES_NAME_PATTERN, 'role name must be lower snake_case starting with a letter'),
    description: z.string().max(ADMIN_ROLES_DESCRIPTION_MAX_LENGTH).nullable(),
    isSystem: z.boolean(),
    permissions: z
      .array(
        z
          .string()
          .min(1)
          .max(ADMIN_ROLES_PERMISSION_STRING_MAX_LENGTH)
          .regex(
            ADMIN_ROLES_PERMISSION_STRING_PATTERN,
            'permission must be a resource:action string',
          ),
      )
      .max(ADMIN_ROLES_PERMISSIONS_MAX)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: 'permissions must not contain duplicates',
      }),
  })
  .strict();
export type RbacCatalogRole = z.infer<typeof RbacCatalogRoleSchema>;

/**
 * The versioned envelope. `exportedAt` is provenance only — importers
 * never act on it. Role names must be unique within one envelope, as
 * must `(resource, action)` pairs.
 */
export const RbacCatalogEnvelopeSchema = z
  .object({
    formatVersion: z.literal(RBAC_CATALOG_FORMAT_VERSION),
    exportedAt: z.string().datetime(),
    permissions: z
      .array(RbacCatalogPermissionSchema)
      .max(ADMIN_ROLES_LIST_MAX)
      .refine((arr) => new Set(arr.map((p) => `${p.resource}:${p.action}`)).size === arr.length, {
        message: 'permissions must not contain duplicate (resource, action) pairs',
      }),
    roles: z
      .array(RbacCatalogRoleSchema)
      .max(ADMIN_ROLES_LIST_MAX)
      .refine((arr) => new Set(arr.map((r) => r.name)).size === arr.length, {
        message: 'roles must not contain duplicate names',
      }),
  })
  .strict();
export type RbacCatalogEnvelope = z.infer<typeof RbacCatalogEnvelopeSchema>;

/**
 * Response body for `GET /api/v1/admin/rbac-catalog/export` — the
 * envelope itself, not wrapped, so the HTTP body IS the importable
 * file (an operator can `curl … > catalog.json` and feed it straight
 * to `rbac:catalog import`).
 */
export const AdminRbacCatalogExportResponseSchema = RbacCatalogEnvelopeSchema;
export type AdminRbacCatalogExportResponse = RbacCatalogEnvelope;
