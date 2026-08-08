'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ConciergeEnrichmentSummaryStatusSchema,
  UpdateConciergeEnrichmentSummaryRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the Tier-3 enrichment-summary DETAIL surface (TS-229).
 *
 *   - `editEnrichmentSummaryAction(summaryId, formData)` — edit the headline +
 *     the three narrative sections + notes.
 *   - `transitionEnrichmentSummaryAction(summaryId, status, _formData)` — drive
 *     the lifecycle (publish / unpublish back to draft / archive).
 *
 * Each re-validates via the contract schema, mints a fresh `Idempotency-Key`,
 * forwards through the gateway BFF (which gates on `concierge:write`), then
 * revalidates + redirects back to the detail page with `?action=ok` (or
 * `?action=err&code=…`).
 */

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function basePath(summaryId: string): string {
  return `/concierge/enrichment-summaries/${encodeURIComponent(summaryId)}`;
}

export async function editEnrichmentSummaryAction(
  summaryId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const field of [
    'headline',
    'visitHighlights',
    'wellnessSignals',
    'socialEngagement',
  ] as const) {
    if (formData.has(field)) {
      const value = stringField(formData, field);
      // These four are non-nullable on the contract — an emptied field is
      // invalid input rather than a clear.
      if (value === null) return redirectWithError(summaryId, 'invalid-input');
      body[field] = value;
    }
  }
  // additionalNotes is nullable — an explicitly-empty field clears it.
  if (formData.has('additionalNotes')) {
    body['additionalNotes'] = stringField(formData, 'additionalNotes'); // string or null
  }

  if (Object.keys(body).length === 0) return redirectWithError(summaryId, 'invalid-input');

  const validated = UpdateConciergeEnrichmentSummaryRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(summaryId, 'invalid-input');

  const key = `admin-concierge-enrichment-edit-${summaryId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/enrichment-summaries/${encodeURIComponent(summaryId)}`,
    { method: 'PATCH', body: validated.data, headers: { 'idempotency-key': key } },
  );
  finish(result, summaryId);
}

export async function transitionEnrichmentSummaryAction(
  summaryId: string,
  status: string,
  _formData: FormData,
): Promise<void> {
  const parsedStatus = ConciergeEnrichmentSummaryStatusSchema.safeParse(status);
  if (!parsedStatus.success) return redirectWithError(summaryId, 'invalid-input');

  const key = `admin-concierge-enrichment-transition-${summaryId}-${parsedStatus.data}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/enrichment-summaries/${encodeURIComponent(summaryId)}`,
    {
      method: 'PATCH',
      body: { status: parsedStatus.data },
      headers: { 'idempotency-key': key },
    },
  );
  finish(result, summaryId);
}

function finish(result: Awaited<ReturnType<typeof callGateway<unknown>>>, summaryId: string): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(basePath(summaryId));
    redirect(`${basePath(summaryId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(summaryId, 'conflict');
    if (result.status === 404) return redirectWithError(summaryId, 'not-found');
    return redirectWithError(summaryId, 'bad-request');
  }
  return redirectWithError(summaryId, 'service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function redirectWithError(summaryId: string, code: ActionErrorCode): never {
  redirect(`${basePath(summaryId)}?action=err&code=${code}`);
}
