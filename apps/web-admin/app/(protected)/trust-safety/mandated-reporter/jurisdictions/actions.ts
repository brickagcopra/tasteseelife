'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SetMandatedReporterJurisdictionVerificationRequestSchema,
  UpsertMandatedReporterJurisdictionRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { problemDetailParam } from '@/lib/problem-detail';

/**
 * Server actions for the jurisdiction kit editor (TS-303c2c).
 *
 * **Two actions, deliberately never one.** Saving a state's details and
 * attesting that those details are correct are separate acts with separate
 * routes, separate audit actions, and separate attribution. Folding the
 * attestation into the edit payload would let it ride along on an unrelated
 * change — which is precisely what the service's design prevents, and the
 * console must not reintroduce it through a checkbox.
 *
 * **Saving may clear an attestation, and that is the point.** Editing any
 * substantive field of a verified row withdraws its verification server-side,
 * because the review covered the old values. The form warns before submit and
 * the result banner says whether it happened; nothing here tries to suppress
 * it.
 *
 * The empty-string convention: an operator clearing a field submits `''`,
 * which becomes an explicit `null` (erase the value) rather than being dropped
 * from the payload (leave it alone). The contract makes every field
 * nullable-optional so both are expressible, and conflating them would make a
 * wrong hotline number impossible to remove.
 */

const KIT_PATH = '/trust-safety/mandated-reporter/jurisdictions';
const GW_KIT = '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions';

export async function saveJurisdictionAction(formData: FormData): Promise<void> {
  const stateCode = stringField(formData, 'stateCode');
  if (stateCode === null) redirect(`${KIT_PATH}?action=err&code=invalid-input`);
  const detailPath = `${KIT_PATH}/${encodeURIComponent(stateCode)}`;

  const deadlineRaw = stringField(formData, 'statutoryDeadlineHours');
  const body: Record<string, unknown> = {
    agencyName: nullableField(formData, 'agencyName'),
    reportingPhone: nullableField(formData, 'reportingPhone'),
    reportingUrl: nullableField(formData, 'reportingUrl'),
    statutoryDeadlineHours: deadlineRaw === null ? null : Number(deadlineRaw),
    statuteCitation: nullableField(formData, 'statuteCitation'),
    notes: nullableField(formData, 'notes'),
    ...(stringField(formData, 'platformRole') !== null && {
      platformRole: stringField(formData, 'platformRole'),
    }),
  };

  const validated = UpsertMandatedReporterJurisdictionRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${detailPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(`${GW_KIT}/${encodeURIComponent(stateCode)}`, {
    method: 'PUT',
    body: validated.data,
    headers: { 'idempotency-key': `admin-mrj-save-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(KIT_PATH);
    revalidatePath(detailPath);
    redirect(`${detailPath}?action=ok&code=saved`);
  }
  if (result.kind === 'client_error') {
    redirect(`${detailPath}?action=err&code=rejected${problemDetailParam(result.body)}`);
  }
  redirect(`${detailPath}?action=err&code=service-warning`);
}

export async function setVerificationAction(formData: FormData): Promise<void> {
  const stateCode = stringField(formData, 'stateCode');
  if (stateCode === null) redirect(`${KIT_PATH}?action=err&code=invalid-input`);
  const detailPath = `${KIT_PATH}/${encodeURIComponent(stateCode)}`;

  const validated = SetMandatedReporterJurisdictionVerificationRequestSchema.safeParse({
    verified: stringField(formData, 'verified') === 'true',
    ...(stringField(formData, 'notes') !== null && { notes: stringField(formData, 'notes') }),
  });
  if (!validated.success) redirect(`${detailPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(
    `${GW_KIT}/${encodeURIComponent(stateCode)}/verification`,
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': `admin-mrj-verify-${randomUUID()}` },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(KIT_PATH);
    revalidatePath(detailPath);
    redirect(`${detailPath}?action=ok&code=${validated.data.verified ? 'attested' : 'withdrawn'}`);
  }
  if (result.kind === 'client_error') {
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

/**
 * A cleared field is an explicit `null`, not an omission — see the module
 * doc-block. Returns `null` for an empty submission, which the contract
 * accepts as "erase this value".
 */
function nullableField(formData: FormData, key: string): string | null {
  return stringField(formData, key);
}
