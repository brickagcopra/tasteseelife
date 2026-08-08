'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdvanceMandatedReporterCaseRequestSchema,
  MandatedReporterCaseResponseSchema,
  OpenMandatedReporterCaseRequestSchema,
  ResolveIncidentRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { problemDetailParam } from '@/lib/problem-detail';

/**
 * Server actions for the mandated-reporter console (TS-303c2b).
 *
 * Each re-validates against the shipped contract, mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), and forwards through the gateway BFF —
 * which re-gates `trust_safety:write` and re-validates, and which
 * service-trust-safety then checks a third time. The console is the most
 * convenient gate and the least trusted one.
 *
 * **Error handling is different here from every other admin surface.** The
 * downstream 409s and 422s on this workflow are written FOR the operator:
 * "the kit for 'NY' has not been verified by compliance", "reviewer signoff
 * must be performed by someone other than the operator who opened the case".
 * Those are forwarded verbatim via `problemDetailParam` and rendered on the
 * page, instead of being flattened into a generic code. An operator working a
 * statutory deadline needs to know what to do next, not that something went
 * wrong.
 *
 * **No PHI in a redirect.** The notes fields these actions SEND are the
 * highest-sensitivity text the platform holds; none of them is ever echoed
 * back into a query string. Only the downstream's own explanation travels
 * that way, and that names a state, a status, and a rule (CLAUDE.md §3.9).
 */

const QUEUE_PATH = '/trust-safety/mandated-reporter';
const GW_CASES = '/api/v1/admin/trust-safety/mandated-reporter/cases';

export async function openCaseAction(formData: FormData): Promise<void> {
  const newPath = `${QUEUE_PATH}/new`;

  const body: Record<string, unknown> = {
    incidentId: stringField(formData, 'incidentId'),
    stateCode: stringField(formData, 'stateCode'),
    ...(stringField(formData, 'determinationNotes') !== null && {
      determinationNotes: stringField(formData, 'determinationNotes'),
    }),
  };

  const validated = OpenMandatedReporterCaseRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${newPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(GW_CASES, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': `admin-mrc-open-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    const parsed = MandatedReporterCaseResponseSchema.safeParse(result.body);
    if (!parsed.success) redirect(`${newPath}?action=err&code=service-warning`);
    revalidatePath(QUEUE_PATH);
    redirect(
      `${QUEUE_PATH}/${encodeURIComponent(parsed.data.case.incidentId)}?action=ok&code=opened`,
    );
  }
  if (result.kind === 'client_error') {
    redirect(`${newPath}?action=err&code=rejected${problemDetailParam(result.body)}`);
  }
  redirect(`${newPath}?action=err&code=service-warning`);
}

export async function advanceCaseAction(formData: FormData): Promise<void> {
  const caseId = stringField(formData, 'caseId');
  const incidentId = stringField(formData, 'incidentId');
  if (caseId === null || incidentId === null)
    redirect(`${QUEUE_PATH}?action=err&code=invalid-input`);
  const detailPath = `${QUEUE_PATH}/${encodeURIComponent(incidentId)}`;

  const body: Record<string, unknown> = {
    to: stringField(formData, 'to'),
    ...(stringField(formData, 'determinationNotes') !== null && {
      determinationNotes: stringField(formData, 'determinationNotes'),
    }),
    ...(stringField(formData, 'filingReference') !== null && {
      filingReference: stringField(formData, 'filingReference'),
    }),
    ...(stringField(formData, 'reviewerNotes') !== null && {
      reviewerNotes: stringField(formData, 'reviewerNotes'),
    }),
  };

  const validated = AdvanceMandatedReporterCaseRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${detailPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(
    `${GW_CASES}/${encodeURIComponent(caseId)}/transitions`,
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': `admin-mrc-advance-${randomUUID()}` },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(QUEUE_PATH);
    revalidatePath(detailPath);
    redirect(`${detailPath}?action=ok&code=advanced`);
  }
  if (result.kind === 'client_error') {
    // 422 (illegal transition / unverified jurisdiction), 409 (self-signoff /
    // lost race), 400 (missing filing reference) — all carry an explanation
    // the operator can act on.
    redirect(`${detailPath}?action=err&code=rejected${problemDetailParam(result.body)}`);
  }
  redirect(`${detailPath}?action=err&code=service-warning`);
}

export async function resolveIncidentAction(formData: FormData): Promise<void> {
  const incidentId = stringField(formData, 'incidentId');
  if (incidentId === null) redirect(`${QUEUE_PATH}?action=err&code=invalid-input`);
  const detailPath = `${QUEUE_PATH}/${encodeURIComponent(incidentId)}`;

  const validated = ResolveIncidentRequestSchema.safeParse({
    resolutionNotes: stringField(formData, 'resolutionNotes'),
  });
  if (!validated.success) redirect(`${detailPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/incidents/${encodeURIComponent(incidentId)}/resolution`,
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': `admin-ts-resolve-${randomUUID()}` },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(QUEUE_PATH);
    revalidatePath(detailPath);
    redirect(`${detailPath}?action=ok&code=resolved`);
  }
  if (result.kind === 'client_error') {
    // The never-auto-close gate lives behind this call: a 409 here means the
    // case has not been signed off, and the operator needs to read exactly
    // that rather than a generic failure.
    redirect(`${detailPath}?action=err&code=rejected${problemDetailParam(result.body)}`);
  }
  redirect(`${detailPath}?action=err&code=service-warning`);
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
