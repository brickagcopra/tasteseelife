'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CreateAdCampaignRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the ad-campaign LIST surface (TS-271b; PRD §10.9; PDD §18.1).
 *
 *   - `createCampaignAction(formData)` — create a campaign with an optional
 *     initial creative + a single targeting rule, then redirect to its editor.
 *
 * Re-validates the payload via the contract schema (defence-in-depth), mints a
 * fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), forwards through the
 * gateway BFF (which gates on `ads:write` + re-validates), then redirects to the
 * new campaign's editor page (or back to the list with `?action=err`).
 *
 * Money: the budget is entered in USD dollars and converted to integer minor
 * units (cents) float-free (CLAUDE.md §4.1, §17.6) before it crosses the wire.
 */

const LIST_PATH = '/ads/campaigns';

type ActionErrorCode = 'invalid-input' | 'conflict' | 'bad-request' | 'service-warning';

export async function createCampaignAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    name: stringField(formData, 'name'),
    advertiserKind: stringField(formData, 'advertiserKind'),
    advertiserId: stringField(formData, 'advertiserId'),
    status: stringField(formData, 'status') ?? 'draft',
  };

  const budgetRaw = stringField(formData, 'budgetUsd');
  if (budgetRaw !== null) {
    const minor = dollarsToMinor(budgetRaw);
    if (minor === null) return redirectWithError('invalid-input');
    body['budgetMinor'] = minor;
  }

  const startAt = localFieldToIso(formData, 'startAt');
  if (startAt === 'invalid') return redirectWithError('invalid-input');
  if (startAt !== null) body['startAt'] = startAt;

  const endAt = localFieldToIso(formData, 'endAt');
  if (endAt === 'invalid') return redirectWithError('invalid-input');
  if (endAt !== null) body['endAt'] = endAt;

  // Optional single creative — included only when a headline is supplied.
  const creativeHeadline = stringField(formData, 'creativeHeadline');
  if (creativeHeadline !== null) {
    const creative: Record<string, unknown> = {
      kind: stringField(formData, 'creativeKind'),
      headline: creativeHeadline,
      status: stringField(formData, 'creativeStatus') ?? 'draft',
    };
    setIfPresent(creative, 'body', stringField(formData, 'creativeBody'));
    setIfPresent(creative, 'ctaUrl', stringField(formData, 'creativeCtaUrl'));
    body['creatives'] = [creative];
  }

  // Optional single targeting rule — included only when a kind + values supplied.
  const targetingKind = stringField(formData, 'targetingKind');
  const targetingValuesRaw = stringField(formData, 'targetingValues');
  if (targetingKind !== null && targetingValuesRaw !== null) {
    const values = parseCommaValues(targetingValuesRaw);
    if (values.length === 0) return redirectWithError('invalid-input');
    body['targetingRules'] = [
      {
        kind: targetingKind,
        predicate: {
          operator: stringField(formData, 'targetingOperator') ?? 'any_of',
          values,
        },
      },
    ];
  }

  const validated = CreateAdCampaignRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const key = `admin-ads-campaign-create-${randomUUID()}`;
  const result = await callGateway<{ campaign: { id: string } }>('/api/v1/admin/ads/campaigns', {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': key },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}/${encodeURIComponent(result.body.campaign.id)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError('conflict');
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

function setIfPresent(bag: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null) bag[key] = value;
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseCommaValues(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * USD dollars string → integer minor units (cents), float-free. Accepts an
 * optional 1–2 digit fraction. Returns null on a malformed value.
 */
function dollarsToMinor(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (m === null) return null;
  const whole = Number.parseInt(m[1] ?? '0', 10);
  const frac = (m[2] ?? '').padEnd(2, '0');
  const cents = whole * 100 + Number.parseInt(frac === '' ? '0' : frac, 10);
  return Number.isFinite(cents) ? cents : null;
}

/** Read a datetime-local field → ISO UTC, or null if absent, or 'invalid'. */
function localFieldToIso(formData: FormData, key: string): string | null | 'invalid' {
  const local = stringField(formData, key);
  if (local === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return 'invalid';
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${LIST_PATH}?action=err&code=${code}`);
}
