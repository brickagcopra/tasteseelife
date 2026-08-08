'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CreateConciergeEnrichmentSummaryRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the Tier-3 enrichment-summary LIST surface (TS-229) —
 * writing a new weekly summary (created as a `draft`).
 *
 * Re-validates the payload via the contract schema (defence-in-depth — the
 * `weekStartDate` Monday check fires here), mints a fresh `Idempotency-Key`
 * (CLAUDE.md §3.3), forwards through the gateway BFF (which gates on
 * `concierge:write` + re-validates), then redirects to the new summary's detail
 * page on success — or back to the list with `?action=err&code=…`.
 */

const LIST_PATH = '/concierge/enrichment-summaries';

type ActionErrorCode = 'invalid-input' | 'conflict' | 'bad-request' | 'service-warning';

export async function createEnrichmentSummaryAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  const weekStartDate = stringField(formData, 'weekStartDate');
  const headline = stringField(formData, 'headline');
  const visitHighlights = stringField(formData, 'visitHighlights');
  const wellnessSignals = stringField(formData, 'wellnessSignals');
  const socialEngagement = stringField(formData, 'socialEngagement');
  if (
    householdId === null ||
    weekStartDate === null ||
    headline === null ||
    visitHighlights === null ||
    wellnessSignals === null ||
    socialEngagement === null
  ) {
    return redirectWithError('invalid-input');
  }

  const body: Record<string, unknown> = {
    householdId,
    weekStartDate,
    headline,
    visitHighlights,
    wellnessSignals,
    socialEngagement,
  };
  const additionalNotes = stringField(formData, 'additionalNotes');
  if (additionalNotes !== null) body['additionalNotes'] = additionalNotes;

  const validated = CreateConciergeEnrichmentSummaryRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const idempotencyKey = `admin-concierge-enrichment-create-${randomUUID()}`;
  const result = await callGateway<{ summary?: { id?: string } }>(
    '/api/v1/admin/concierge/enrichment-summaries',
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    const id = result.body?.summary?.id;
    if (typeof id === 'string' && id.length > 0) {
      redirect(`${LIST_PATH}/${encodeURIComponent(id)}?action=ok`);
    }
    redirect(`${LIST_PATH}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError('conflict');
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${LIST_PATH}?action=err&code=${code}`);
}
