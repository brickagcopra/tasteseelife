'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ScheduleFeaturedPlacementRequestSchema,
  type ScheduleFeaturedPlacementRequest,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the admin featured-placements browser (TS-207;
 * PRD §7.2, §10.5; PDD §14.1).
 *
 *   - `scheduleFeaturedPlacementAction(formData)` — the "schedule" form
 *     submits here. Parses the form, converts the `datetime-local` window
 *     into offset-ISO strings, re-validates via the contract schema as
 *     defence-in-depth, then POSTs through the gateway BFF.
 *
 *   - `cancelFeaturedPlacementAction(placementId)` — bound to the per-row
 *     cancel button. DELETEs through the gateway; the downstream is
 *     idempotent (a gone row returns `not_found`).
 *
 * Every mutation generates a fresh `Idempotency-Key` per submission
 * (CLAUDE.md §3.3). On success the action revalidates the page path and
 * redirects back with `?action=ok` for the inline success banner.
 */

const PAGE_PATH = '/search/featured-placements';

type ActionErrorCode =
  | 'provider-required'
  | 'region-invalid'
  | 'tier-invalid'
  | 'boost-invalid'
  | 'dates-required'
  | 'window-invalid'
  | 'note-too-long'
  | 'bad-request'
  | 'not-found'
  | 'service-warning';

export async function scheduleFeaturedPlacementAction(formData: FormData): Promise<void> {
  const providerId = stringField(formData, 'providerId');
  if (providerId === null) {
    return redirectWithError('provider-required');
  }

  const startsAt = isoFromLocal(formData.get('startsAt'));
  const endsAt = isoFromLocal(formData.get('endsAt'));
  if (startsAt === null || endsAt === null) {
    return redirectWithError('dates-required');
  }

  const boostRaw = formData.get('boostMultiplier');
  const boost = parseBoost(boostRaw);
  if (boost === null) {
    return redirectWithError('boost-invalid');
  }

  const body: Record<string, unknown> = {
    providerId,
    boostMultiplier: boost,
    startsAt,
    endsAt,
  };
  const regionCode = stringField(formData, 'regionCode');
  if (regionCode !== null) body['regionCode'] = regionCode;
  const tier = stringField(formData, 'tier');
  if (tier !== null) body['tier'] = tier;
  const note = stringField(formData, 'note');
  if (note !== null) body['note'] = note;

  // Defence-in-depth — re-validate locally so a malformed body surfaces
  // here rather than bouncing off the gateway 400.
  const validated = ScheduleFeaturedPlacementRequestSchema.safeParse(body);
  if (!validated.success) {
    return redirectWithError(classifyIssue(validated.error.issues));
  }

  const idempotencyKey = `admin-featured-${providerId}-${randomUUID()}`;
  const result = await callGateway<unknown>('/api/v1/admin/search/featured-placements', {
    method: 'POST',
    body: validated.data satisfies ScheduleFeaturedPlacementRequest,
    headers: { 'idempotency-key': idempotencyKey },
  });

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess();
  }
  if (result.kind === 'client_error') {
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

export async function cancelFeaturedPlacementAction(placementId: string): Promise<void> {
  if (placementId.length === 0) {
    return redirectWithError('bad-request');
  }
  const idempotencyKey = `admin-featured-del-${placementId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/search/featured-placements/${encodeURIComponent(placementId)}`,
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

/** Convert a browser `datetime-local` value to an offset-ISO string. */
function isoFromLocal(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseBoost(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyIssue(issues: readonly { path: (string | number)[] }[]): ActionErrorCode {
  if (issues.some((i) => i.path.includes('endsAt') || i.path.includes('startsAt')))
    return 'window-invalid';
  if (issues.some((i) => i.path.includes('boostMultiplier'))) return 'boost-invalid';
  if (issues.some((i) => i.path.includes('regionCode'))) return 'region-invalid';
  if (issues.some((i) => i.path.includes('tier'))) return 'tier-invalid';
  if (issues.some((i) => i.path.includes('note'))) return 'note-too-long';
  return 'bad-request';
}

function redirectWithSuccess(): never {
  redirect(`${PAGE_PATH}?action=ok`);
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${PAGE_PATH}?action=err&code=${code}`);
}
