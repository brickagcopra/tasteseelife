'use client';

import { useActionState } from 'react';
import type {
  BulkRoleAssignmentOutcome,
  BulkRoleAssignmentRow,
  BulkRoleAssignmentVerdict,
} from '@taste-and-see/contracts';

import {
  commitBulkAssignmentsAction,
  previewBulkAssignmentsAction,
  type BulkFlowState,
} from './actions';

/**
 * Bulk role-assignment flow (TS-292): upload → per-row preview →
 * confirm → per-row outcomes. A client component ONLY for
 * `useActionState` — there is no client-side logic beyond wiring the
 * two server actions; the flow still works before hydration (React
 * posts the form and re-renders with the returned state), so the
 * roles area's no-JS-required property is preserved.
 */
export function BulkAssignmentsFlow({
  canWrite,
}: {
  readonly canWrite: boolean;
}): React.JSX.Element {
  const [state, previewAction] = useActionState<BulkFlowState, FormData>(
    previewBulkAssignmentsAction,
    { kind: 'idle' },
  );
  const [commitState, commitAction] = useActionState<BulkFlowState, FormData>(
    commitBulkAssignmentsAction,
    { kind: 'idle' },
  );

  // A completed commit supersedes the preview it came from.
  if (commitState.kind === 'committed') {
    return <OutcomesTable state={commitState} />;
  }

  return (
    <div className="bulk-assign">
      {commitState.kind === 'error' && (
        <p className="auth-alert" role="alert">
          {commitState.message}
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-alert" role="alert">
          {state.message}
        </p>
      )}

      <form action={previewAction} className="bulk-assign__upload">
        <label className="bulk-assign__file-label">
          CSV file
          <input type="file" name="csv" accept=".csv,text/csv" required />
        </label>
        <button type="submit" className="user-detail__action-button">
          Validate sheet
        </button>
      </form>

      {state.kind === 'previewed' && (
        <PreviewTable state={state} canWrite={canWrite} commitAction={commitAction} />
      )}
    </div>
  );
}

function PreviewTable({
  state,
  canWrite,
  commitAction,
}: {
  readonly state: Extract<BulkFlowState, { kind: 'previewed' }>;
  readonly canWrite: boolean;
  readonly commitAction: (formData: FormData) => void;
}): React.JSX.Element {
  return (
    <section className="user-detail__section" aria-label="Preview results">
      <h2>Preview — nothing applied yet</h2>
      <p role="status">
        <strong>{state.okCount}</strong> row{state.okCount === 1 ? '' : 's'} ready to grant,{' '}
        <strong>{state.errorCount}</strong> with problems.
        {state.errorCount > 0 &&
          ' Rows with problems are skipped at commit — fix them in the sheet and re-upload to include them.'}
      </p>
      <table className="perm-matrix bulk-assign__table">
        <caption className="sr-only">Per-row validation results for the uploaded sheet</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">User</th>
            <th scope="col">Role</th>
            <th scope="col">Scope</th>
            <th scope="col">Expires</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {state.verdicts.map((verdict) => (
            <PreviewRow key={verdict.index} verdict={verdict} row={state.rows[verdict.index]} />
          ))}
        </tbody>
      </table>

      {state.okCount > 0 &&
        (canWrite ? (
          <form action={commitAction} className="bulk-assign__commit">
            <input type="hidden" name="payload" value={JSON.stringify(okRows(state))} />
            <label className="bulk-assign__confirm">
              <input type="checkbox" name="confirmCommit" required />I reviewed the {state.okCount}{' '}
              valid row{state.okCount === 1 ? '' : 's'} and want to apply the grants.
            </label>
            <button
              type="submit"
              className="user-detail__action-button user-detail__action-button--danger"
            >
              Apply {state.okCount} grant{state.okCount === 1 ? '' : 's'}
            </button>
          </form>
        ) : (
          <p className="user-detail__hint">
            You can validate sheets with <code>rbac:read</code>, but committing grants requires{' '}
            <code>rbac:write</code>.
          </p>
        ))}
    </section>
  );
}

/** The subset of uploaded rows the preview validated OK, in order. */
function okRows(
  state: Extract<BulkFlowState, { kind: 'previewed' }>,
): readonly BulkRoleAssignmentRow[] {
  const okIndexes = new Set(state.verdicts.filter((v) => v.ok).map((v) => v.index));
  return state.rows.filter((_, index) => okIndexes.has(index));
}

function PreviewRow({
  verdict,
  row,
}: {
  readonly verdict: BulkRoleAssignmentVerdict;
  readonly row: BulkRoleAssignmentRow | undefined;
}): React.JSX.Element {
  return (
    <tr>
      <td>{verdict.index + 2}</td>
      <td className="user-detail__mono">{row?.userId ?? '—'}</td>
      <td>{row?.roleName ?? '—'}</td>
      <td>
        {row?.scopeType ?? '—'}
        {row?.scopeId !== null && row?.scopeId !== undefined && (
          <span className="user-detail__hint"> {row.scopeId}</span>
        )}
      </td>
      <td>{row?.expiresAt ?? 'never'}</td>
      <td>
        {verdict.ok ? (
          <span className="perm-diff__chip perm-diff__chip--added">✓ Ready</span>
        ) : (
          <>
            <span className="perm-diff__chip perm-diff__chip--removed">✗ Problem</span>
            <ul className="bulk-assign__errors">
              {verdict.errors.map((error, i) => (
                <li key={i}>
                  <code>{error.field}</code>: {error.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </td>
    </tr>
  );
}

function OutcomesTable({
  state,
}: {
  readonly state: Extract<BulkFlowState, { kind: 'committed' }>;
}): React.JSX.Element {
  return (
    <section className="user-detail__section" aria-label="Commit outcomes">
      <h2>Batch applied</h2>
      <p role="status">
        <strong>{state.grantedCount}</strong> granted, <strong>{state.conflictCount}</strong>{' '}
        already held (no change), <strong>{state.errorCount}</strong> failed.
      </p>
      <table className="perm-matrix bulk-assign__table">
        <caption className="sr-only">Per-row grant outcomes</caption>
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Role</th>
            <th scope="col">Outcome</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {state.outcomes.map((outcome) => (
            <OutcomeRow key={outcome.index} outcome={outcome} row={state.rows[outcome.index]} />
          ))}
        </tbody>
      </table>
      <p className="user-detail__hint">
        Every grant was audit-logged with your operator id. Upload another sheet to run a new batch.
      </p>
    </section>
  );
}

function OutcomeRow({
  outcome,
  row,
}: {
  readonly outcome: BulkRoleAssignmentOutcome;
  readonly row: BulkRoleAssignmentRow | undefined;
}): React.JSX.Element {
  return (
    <tr>
      <td className="user-detail__mono">{row?.userId ?? '—'}</td>
      <td>{row?.roleName ?? '—'}</td>
      <td>
        {outcome.status === 'granted' && (
          <span className="perm-diff__chip perm-diff__chip--added">✓ Granted</span>
        )}
        {outcome.status === 'conflict' && <span className="perm-diff__chip">Already held</span>}
        {outcome.status === 'error' && (
          <span className="perm-diff__chip perm-diff__chip--removed">✗ Failed</span>
        )}
      </td>
      <td>{outcome.message ?? (outcome.assignmentId !== null ? outcome.assignmentId : '—')}</td>
    </tr>
  );
}
