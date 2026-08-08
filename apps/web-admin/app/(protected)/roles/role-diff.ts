import type { AdminRoleRecord } from '@taste-and-see/contracts';

/**
 * Role-edit diff computation (TS-291; PRD §10.12). Pure helpers shared
 * by the editor (draft rehydration) and the review step (before/after
 * diff). The edit form GETs its pending state to the review page as
 * query params (`name`, `description`, `perm__<resource:action>`);
 * these helpers parse that shape and diff it against the role's
 * current server state. No client JS anywhere in the flow.
 */

export interface RoleEditProposal {
  /** Proposed role name; null = blank input = keep the current name. */
  readonly name: string | null;
  /** Proposed description; null = blank input = clear it. */
  readonly description: string | null;
  /** Proposed permission set (sorted, deduped, catalog-filtered). */
  readonly permissions: readonly string[];
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Parse a pending edit out of review/draft query params. Permission
 * keys are filtered to the live catalog: the checkboxes only ever emit
 * catalog values, so anything else is a crafted URL — dropping it here
 * keeps the rendered diff honest (the service re-validates on apply
 * regardless).
 */
export function parseProposalFromSearch(
  search: SearchParams,
  allowedPermissions: ReadonlySet<string>,
): RoleEditProposal {
  const permissions: string[] = [];
  for (const key of Object.keys(search)) {
    if (!key.startsWith('perm__')) continue;
    const value = key.slice('perm__'.length);
    if (allowedPermissions.has(value)) permissions.push(value);
  }
  return {
    name: trimmedOrNull(search['name']),
    description: trimmedOrNull(search['description']),
    permissions: [...new Set(permissions)].sort(),
  };
}

/** Mirror of the server actions' `stringField`: trim, empty → null. */
function trimmedOrNull(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Serialize a proposal back into query params (review URL, back-to-edit draft link). */
export function proposalToQuery(proposal: RoleEditProposal): URLSearchParams {
  const params = new URLSearchParams();
  if (proposal.name !== null) params.set('name', proposal.name);
  if (proposal.description !== null) params.set('description', proposal.description);
  for (const permission of proposal.permissions) params.set(`perm__${permission}`, 'on');
  return params;
}

export type PermissionChangeStatus = 'unchanged' | 'added' | 'removed';

export interface PermissionDiffEntry {
  /** Full `resource:action` string. */
  readonly value: string;
  /** Action segment (display; the resource is the row heading). */
  readonly action: string;
  readonly status: PermissionChangeStatus;
}

export interface ResourceDiff {
  readonly resource: string;
  /** All entries for this resource across before ∪ after, action-sorted. */
  readonly entries: readonly PermissionDiffEntry[];
}

export interface RoleDiff {
  readonly nameBefore: string;
  readonly nameAfter: string;
  readonly nameChanged: boolean;
  readonly descriptionBefore: string | null;
  readonly descriptionAfter: string | null;
  readonly descriptionChanged: boolean;
  /** Resources containing at least one addition or removal. */
  readonly changedResources: readonly ResourceDiff[];
  /** Resources where every permission is unchanged (collapsed in the UI). */
  readonly unchangedResources: readonly ResourceDiff[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly unchangedCount: number;
  readonly hasChanges: boolean;
}

/**
 * Diff the role's current server state against a proposal. Grouping
 * derives the resource from the permission string itself (not the
 * catalog), so a stale grant whose permission has left the catalog
 * still shows up — as a removal, which is exactly what applying the
 * PATCH would do to it.
 */
export function computeRoleDiff(current: AdminRoleRecord, proposal: RoleEditProposal): RoleDiff {
  const before = new Set(current.permissions);
  const after = new Set(proposal.permissions);
  const union = [...new Set([...before, ...after])].sort();

  const byResource = new Map<string, PermissionDiffEntry[]>();
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  for (const value of union) {
    const separator = value.indexOf(':');
    const resource = separator === -1 ? value : value.slice(0, separator);
    const action = separator === -1 ? value : value.slice(separator + 1);
    const status: PermissionChangeStatus = before.has(value)
      ? after.has(value)
        ? 'unchanged'
        : 'removed'
      : 'added';
    if (status === 'added') addedCount += 1;
    else if (status === 'removed') removedCount += 1;
    else unchangedCount += 1;
    const bucket = byResource.get(resource) ?? [];
    bucket.push({ value, action, status });
    byResource.set(resource, bucket);
  }

  const resources: ResourceDiff[] = [...byResource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resource, entries]) => ({ resource, entries }));

  const changedResources = resources.filter((r) => r.entries.some((e) => e.status !== 'unchanged'));
  const unchangedResources = resources.filter((r) =>
    r.entries.every((e) => e.status === 'unchanged'),
  );

  const nameAfter = proposal.name ?? current.name;
  const nameChanged = nameAfter !== current.name;
  const descriptionChanged = proposal.description !== current.description;

  return {
    nameBefore: current.name,
    nameAfter,
    nameChanged,
    descriptionBefore: current.description,
    descriptionAfter: proposal.description,
    descriptionChanged,
    changedResources,
    unchangedResources,
    addedCount,
    removedCount,
    unchangedCount,
    hasChanges: nameChanged || descriptionChanged || addedCount > 0 || removedCount > 0,
  };
}
