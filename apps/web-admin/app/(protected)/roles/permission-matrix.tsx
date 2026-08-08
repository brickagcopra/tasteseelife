import type { AdminPermissionRecord } from '@taste-and-see/contracts';

/**
 * Visual permission matrix (TS-290/TS-291 seed; PRD §10.12). Groups
 * the flat permission catalog by resource — one semantic table row
 * per resource, one labelled checkbox per action — so an operator
 * can scan "what can this role do" without reading a flat list.
 *
 * Server component: plain checkboxes inside the surrounding form
 * POST (no client JS). Checkbox names are `perm__<resource:action>`;
 * the server action collects every checked `perm__*` key into the
 * permission-string array. When `readOnly` (system or archived
 * roles) the checkboxes are disabled and the explanatory copy is the
 * caller's responsibility.
 */
export function PermissionMatrix({
  permissions,
  selected,
  readOnly = false,
}: {
  readonly permissions: readonly AdminPermissionRecord[];
  readonly selected: ReadonlySet<string>;
  readonly readOnly?: boolean;
}): React.JSX.Element {
  const byResource = groupByResource(permissions);

  if (permissions.length === 0) {
    return (
      <p className="user-empty">
        No permissions in the catalog yet. Permissions are seeded from the service-identity catalog
        (<code>pnpm seed:rbac</code>).
      </p>
    );
  }

  return (
    <table className="perm-matrix">
      <caption className="sr-only">
        Permission matrix — one row per resource, one checkbox per action
      </caption>
      <thead>
        <tr>
          <th scope="col">Resource</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {byResource.map(([resource, entries]) => (
          <tr key={resource}>
            <th scope="row">
              <code>{resource}</code>
            </th>
            <td>
              <ul className="perm-matrix__actions" role="list">
                {entries.map((permission) => {
                  const value = `${permission.resource}:${permission.action}`;
                  return (
                    <li key={value} className="perm-matrix__action">
                      <label className="perm-matrix__label">
                        <input
                          type="checkbox"
                          name={`perm__${value}`}
                          defaultChecked={selected.has(value)}
                          disabled={readOnly}
                        />
                        <span>
                          <code>{permission.action}</code>
                          {permission.description !== null && (
                            <span className="perm-matrix__description">
                              {' '}
                              — {permission.description}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Stable (resource-sorted) grouping of the flat catalog. */
function groupByResource(
  permissions: readonly AdminPermissionRecord[],
): ReadonlyArray<readonly [string, readonly AdminPermissionRecord[]]> {
  const groups = new Map<string, AdminPermissionRecord[]>();
  for (const permission of permissions) {
    const bucket = groups.get(permission.resource) ?? [];
    bucket.push(permission);
    groups.set(permission.resource, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resource, entries]) => [
      resource,
      [...entries].sort((a, b) => a.action.localeCompare(b.action)),
    ]);
}

/** Collect checked `perm__*` fields back into permission strings. */
export function readMatrixSelection(formData: FormData): string[] {
  const selected: string[] = [];
  for (const key of formData.keys()) {
    if (key.startsWith('perm__')) selected.push(key.slice('perm__'.length));
  }
  return [...new Set(selected)].sort();
}
