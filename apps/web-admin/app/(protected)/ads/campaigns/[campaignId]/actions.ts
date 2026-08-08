'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdCampaignStatusSchema,
  AdCreativeStatusSchema,
  UpdateAdCampaignRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the ad-campaign EDITOR surface (TS-271b; PRD §10.9; PDD
 * §18.1, §8.2).
 *
 *   - `updateCampaignAction`        — edit campaign scalars (name / advertiserId /
 *                                     budget / window).
 *   - `transitionCampaignAction`    — move the campaign through its status matrix.
 *   - `updateCreativeStatusAction`  — advance a creative through its review status.
 *
 * Each re-validates via the contract schema (defence-in-depth), mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), forwards through the gateway BFF (which
 * gates on `ads:write` + re-validates), then revalidates + redirects back to the
 * campaign editor with `?action=ok` (or `?action=err&code=…`). The budget is
 * carried float-free in integer minor units (CLAUDE.md §4.1, §17.6).
 */

const LIST_PATH = '/ads/campaigns';
const GW_CAMPAIGNS = '/api/v1/admin/ads/campaigns';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(campaignId: string): string {
  return `${LIST_PATH}/${encodeURIComponent(campaignId)}`;
}

export async function updateCampaignAction(campaignId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};

  // Non-nullable scalar — set only when a non-empty value is supplied.
  const name = stringField(formData, 'name');
  if (name !== null) body['name'] = name;

  // Nullable scalars — present field with empty value clears (→ null).
  if (formData.has('advertiserId')) body['advertiserId'] = stringField(formData, 'advertiserId');

  if (formData.has('budgetUsd')) {
    const raw = stringField(formData, 'budgetUsd');
    if (raw === null) {
      body['budgetMinor'] = null;
    } else {
      const minor = dollarsToMinor(raw);
      if (minor === null) return redirectWithError(campaignId, 'invalid-input');
      body['budgetMinor'] = minor;
    }
  }

  if (formData.has('startAt')) {
    const iso = localToIso(stringField(formData, 'startAt'));
    if (iso === 'invalid') return redirectWithError(campaignId, 'invalid-input');
    body['startAt'] = iso;
  }
  if (formData.has('endAt')) {
    const iso = localToIso(stringField(formData, 'endAt'));
    if (iso === 'invalid') return redirectWithError(campaignId, 'invalid-input');
    body['endAt'] = iso;
  }

  if (Object.keys(body).length === 0) return redirectWithError(campaignId, 'invalid-input');

  const validated = UpdateAdCampaignRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(campaignId, 'invalid-input');

  const result = await send(
    `${GW_CAMPAIGNS}/${encodeURIComponent(campaignId)}`,
    validated.data,
    'campaign-update',
    campaignId,
  );
  finish(result, campaignId);
}

export async function transitionCampaignAction(
  campaignId: string,
  status: string,
  _formData: FormData,
): Promise<void> {
  const parsed = AdCampaignStatusSchema.safeParse(status);
  if (!parsed.success) return redirectWithError(campaignId, 'invalid-input');
  const result = await send(
    `${GW_CAMPAIGNS}/${encodeURIComponent(campaignId)}`,
    { status: parsed.data },
    'campaign-transition',
    campaignId,
  );
  finish(result, campaignId);
}

export async function updateCreativeStatusAction(
  campaignId: string,
  creativeId: string,
  status: string,
  _formData: FormData,
): Promise<void> {
  const parsed = AdCreativeStatusSchema.safeParse(status);
  if (!parsed.success) return redirectWithError(campaignId, 'invalid-input');
  const result = await send(
    `${GW_CAMPAIGNS}/${encodeURIComponent(campaignId)}/creatives/${encodeURIComponent(creativeId)}`,
    { status: parsed.data },
    'creative-status',
    campaignId,
  );
  finish(result, campaignId);
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

async function send(
  path: string,
  body: unknown,
  surface: string,
  campaignId: string,
): Promise<Awaited<ReturnType<typeof callGateway<unknown>>>> {
  const key = `admin-ads-${surface}-${campaignId}-${randomUUID()}`;
  return callGateway<unknown>(path, {
    method: 'PATCH',
    body,
    headers: { 'idempotency-key': key },
  });
}

function finish(
  result: Awaited<ReturnType<typeof callGateway<unknown>>>,
  campaignId: string,
): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath(campaignId));
    redirect(`${detailPath(campaignId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(campaignId, 'conflict');
    if (result.status === 404) return redirectWithError(campaignId, 'not-found');
    return redirectWithError(campaignId, 'bad-request');
  }
  return redirectWithError(campaignId, 'service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * USD dollars string → integer minor units (cents), float-free. Accepts an
 * optional 1–2 digit fraction. Returns null on a malformed value.
 */
function dollarsToMinor(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (m === null) return null;
  const whole = Number.parseInt(m[1] ?? '0', 10);
  const fracDigits = m[2] ?? '';
  const frac = fracDigits.padEnd(2, '0');
  const cents = whole * 100 + Number.parseInt(frac === '' ? '0' : frac, 10);
  return Number.isFinite(cents) ? cents : null;
}

/** datetime-local → ISO UTC string, null (clear) when empty, or 'invalid'. */
function localToIso(local: string | null): string | null | 'invalid' {
  if (local === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return 'invalid';
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(campaignId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(campaignId)}?action=err&code=${code}`);
}
