'use server';

import { randomUUID } from 'node:crypto';
import {
  BulkRoleAssignmentsCommitRequestSchema,
  BulkRoleAssignmentsCommitResponseSchema,
  BulkRoleAssignmentsPreviewRequestSchema,
  BulkRoleAssignmentsPreviewResponseSchema,
  type BulkRoleAssignmentOutcome,
  type BulkRoleAssignmentRow,
  type BulkRoleAssignmentVerdict,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { parseBulkAssignmentsCsv } from './csv';

/**
 * Server actions for the bulk role-assignment workflow (TS-292).
 *
 * Both actions are `useActionState` reducers — the form posts, the
 * action runs on the server, and the returned state renders the next
 * step. This works WITHOUT client JavaScript (React handles pre-
 * hydration form posts by re-rendering with the returned state), so
 * the flow keeps the roles area's no-JS-required property while
 * letting a hydrated client show the same thing without a full reload.
 *
 * Validation authority stays server-side end-to-end: the CSV parse +
 * wire-shape check here, per-row semantics in service-identity's
 * bulk-preview, and everything re-checked at bulk-commit.
 */

/** Cap uploads well above any legitimate 500-row sheet (~100 bytes/row). */
const MAX_CSV_BYTES = 512 * 1024;

export type BulkFlowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'previewed';
      readonly rows: readonly BulkRoleAssignmentRow[];
      readonly verdicts: readonly BulkRoleAssignmentVerdict[];
      readonly okCount: number;
      readonly errorCount: number;
    }
  | {
      readonly kind: 'committed';
      readonly rows: readonly BulkRoleAssignmentRow[];
      readonly outcomes: readonly BulkRoleAssignmentOutcome[];
      readonly grantedCount: number;
      readonly conflictCount: number;
      readonly errorCount: number;
    };

export async function previewBulkAssignmentsAction(
  _prev: BulkFlowState,
  formData: FormData,
): Promise<BulkFlowState> {
  const file = formData.get('csv');
  if (!(file instanceof File) || file.size === 0) {
    return { kind: 'error', message: 'Choose a CSV file to upload.' };
  }
  if (file.size > MAX_CSV_BYTES) {
    return { kind: 'error', message: 'The file is too large (512 KB max).' };
  }

  const text = await file.text();
  const parsed = parseBulkAssignmentsCsv(text);
  if (parsed.kind === 'error') {
    return { kind: 'error', message: parsed.message };
  }

  const request = BulkRoleAssignmentsPreviewRequestSchema.safeParse({ rows: parsed.rows });
  if (!request.success) {
    return { kind: 'error', message: 'The parsed sheet failed contract validation.' };
  }

  const result = await callGateway<unknown>('/api/v1/admin/role-assignments/bulk-preview', {
    method: 'POST',
    body: request.data,
  });
  if (result.kind === 'unauthorized') {
    return { kind: 'error', message: 'Your session expired — sign in again.' };
  }
  if (result.kind !== 'ok') {
    return {
      kind: 'error',
      message: 'The validation service is briefly unreachable. Try again in a moment.',
    };
  }
  const response = BulkRoleAssignmentsPreviewResponseSchema.safeParse(result.body);
  if (!response.success) {
    return { kind: 'error', message: 'The validation service returned an unexpected shape.' };
  }

  return {
    kind: 'previewed',
    rows: request.data.rows,
    verdicts: response.data.verdicts,
    okCount: response.data.okCount,
    errorCount: response.data.errorCount,
  };
}

export async function commitBulkAssignmentsAction(
  _prev: BulkFlowState,
  formData: FormData,
): Promise<BulkFlowState> {
  if (formData.get('confirmCommit') !== 'on') {
    return { kind: 'error', message: 'Tick the confirmation box to apply the grants.' };
  }

  // The preview step serialized ONLY its ok rows into the hidden
  // `payload` field; error rows stay in the sheet for the operator to
  // fix and re-upload. Tampering is harmless — the service re-runs
  // every per-row check at bulk-commit (validation authority is
  // server-side end-to-end).
  const raw = formData.get('payload');
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'error', message: 'Upload and preview a sheet before committing.' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: 'error', message: 'The commit payload is not valid JSON. Re-run the preview.' };
  }

  const request = BulkRoleAssignmentsCommitRequestSchema.safeParse({ rows: payload });
  if (!request.success) {
    return {
      kind: 'error',
      message: 'The commit batch failed contract validation. Re-run the preview.',
    };
  }
  const rows = request.data.rows;

  const result = await callGateway<unknown>('/api/v1/admin/role-assignments/bulk-commit', {
    method: 'POST',
    body: request.data,
    headers: { 'idempotency-key': `admin-role-assignments-bulk-${randomUUID()}` },
  });
  if (result.kind === 'unauthorized') {
    return { kind: 'error', message: 'Your session expired — sign in again.' };
  }
  if (result.kind === 'client_error') {
    return {
      kind: 'error',
      message:
        result.status === 403
          ? 'You do not have the rbac:write permission required to commit grants.'
          : 'The commit was rejected by the service. Re-run the preview and try again.',
    };
  }
  if (result.kind !== 'ok') {
    return {
      kind: 'error',
      message: 'The service is briefly unreachable. The batch was NOT applied — try again.',
    };
  }
  const response = BulkRoleAssignmentsCommitResponseSchema.safeParse(result.body);
  if (!response.success) {
    return { kind: 'error', message: 'The service returned an unexpected commit shape.' };
  }

  return {
    kind: 'committed',
    rows,
    outcomes: response.data.outcomes,
    grantedCount: response.data.grantedCount,
    conflictCount: response.data.conflictCount,
    errorCount: response.data.errorCount,
  };
}
