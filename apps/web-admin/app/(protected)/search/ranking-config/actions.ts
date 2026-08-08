'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  SearchRankingConfigRegionCodeSchema,
  SearchRankingTierWeightSchema,
  UpsertSearchRankingConfigRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the admin search ranking-config admin browser
 * (TS-211-followup-2; PRD §10.5, PDD §14.1).
 *
 * Three actions:
 *
 *   - `upsertRankingConfigAction(regionCode, formData)` — used by both
 *     the per-row "save" form and the "add region" form at the page
 *     foot. The regionCode is bound at the call site so the form body
 *     carries only the editable fields.
 *
 *   - `createRankingConfigAction(formData)` — the "add region" form
 *     submits here so the new regionCode is part of the body. The
 *     action delegates to `upsertRankingConfigAction` once it has
 *     validated the regionCode.
 *
 *   - `deleteRankingConfigAction(regionCode)` — bound to the per-row
 *     delete button. Disabled in the UI for the `global` row but the
 *     downstream `DELETE` rejects it with 422 (`global_protected`)
 *     for defence-in-depth — the action surfaces that as the
 *     `protected` error code in the banner.
 *
 * Every mutation generates a fresh `Idempotency-Key` per submission
 * (CLAUDE.md §3.3) so a server-action retry collapses on the
 * downstream's `@Idempotent()` cache when that ever lands. The key is
 * short-lived (one form submission); we deliberately do NOT embed it
 * as a hidden input the user can manipulate.
 *
 * On success the action revalidates the page path so the post-action
 * state renders immediately, then redirects back with `?action=ok`
 * for the inline success banner.
 */

const PAGE_PATH = '/search/ranking-config';

type ActionErrorCode =
  | 'region-required'
  | 'region-invalid'
  | 'weight-invalid'
  | 'weight-required'
  | 'description-too-long'
  | 'protected'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

export async function upsertRankingConfigAction(
  regionCode: string,
  formData: FormData,
): Promise<void> {
  const regionParsed = SearchRankingConfigRegionCodeSchema.safeParse(regionCode);
  if (!regionParsed.success) {
    return redirectWithError('region-invalid');
  }

  const description = formData.get('description');
  const basicRaw = formData.get('tierWeightBasic');
  const certifiedRaw = formData.get('tierWeightCertified');
  const eliteRaw = formData.get('tierWeightElite');

  const basic = parseWeight(basicRaw);
  const certified = parseWeight(certifiedRaw);
  const elite = parseWeight(eliteRaw);
  if (basic === null || certified === null || elite === null) {
    return redirectWithError('weight-invalid');
  }

  const body: Record<string, unknown> = {
    tierWeightBasic: basic,
    tierWeightCertified: certified,
    tierWeightElite: elite,
  };
  if (typeof description === 'string' && description.trim().length > 0) {
    body['description'] = description.trim();
  }

  // Defence-in-depth — re-validate via the contract schema BEFORE
  // sending so a malformed body surfaces locally rather than
  // bouncing off the gateway 400.
  const validated = UpsertSearchRankingConfigRequestSchema.safeParse(body);
  if (!validated.success) {
    if (validated.error.issues.some((i) => i.path.includes('description'))) {
      return redirectWithError('description-too-long');
    }
    if (
      validated.error.issues.some((i) => i.path.some((p) => String(p).startsWith('tierWeight')))
    ) {
      return redirectWithError('weight-invalid');
    }
    return redirectWithError('bad-request');
  }

  const idempotencyKey = `admin-search-rnk-${regionParsed.data}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/search/ranking-config/${encodeURIComponent(regionParsed.data)}`,
    {
      method: 'PUT',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess();
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) return redirectWithError('not-found');
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

export async function createRankingConfigAction(formData: FormData): Promise<void> {
  const regionCodeRaw = formData.get('regionCode');
  if (typeof regionCodeRaw !== 'string' || regionCodeRaw.trim().length === 0) {
    return redirectWithError('region-required');
  }
  const regionParsed = SearchRankingConfigRegionCodeSchema.safeParse(regionCodeRaw.trim());
  if (!regionParsed.success) {
    return redirectWithError('region-invalid');
  }
  return upsertRankingConfigAction(regionParsed.data, formData);
}

export async function deleteRankingConfigAction(regionCode: string): Promise<void> {
  if (regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL) {
    // Defence-in-depth — the UI disables the delete button for the
    // `global` row but a forged POST could still reach the action.
    return redirectWithError('protected');
  }
  const regionParsed = SearchRankingConfigRegionCodeSchema.safeParse(regionCode);
  if (!regionParsed.success) {
    return redirectWithError('region-invalid');
  }

  const idempotencyKey = `admin-search-rnk-del-${regionParsed.data}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/search/ranking-config/${encodeURIComponent(regionParsed.data)}`,
    {
      method: 'DELETE',
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess();
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) return redirectWithError('not-found');
    if (result.status === 422) return redirectWithError('protected');
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

function parseWeight(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const validated = SearchRankingTierWeightSchema.safeParse(parsed);
  return validated.success ? validated.data : null;
}

function redirectWithSuccess(): never {
  redirect(`${PAGE_PATH}?action=ok`);
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${PAGE_PATH}?action=err&code=${code}`);
}
