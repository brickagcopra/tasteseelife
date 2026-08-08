'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CreateAcademyCourseRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the Cooking-Academy course-catalog LIST surface
 * (TS-251-followup-1; PRD §9.5; PDD §10.1).
 *
 *   - `createCourseAction(formData)` — create a new course (draft or
 *     create-and-publish), then redirect to its detail page.
 *
 * Re-validates the payload via the contract schema (defence-in-depth), mints a
 * fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), forwards through the
 * gateway BFF (which gates on `academy:write` + re-validates), then redirects to
 * the new course's catalog-editor page (or back to the list with `?action=err`).
 */

const LIST_PATH = '/academy/courses';

type ActionErrorCode = 'invalid-input' | 'conflict' | 'bad-request' | 'service-warning';

export async function createCourseAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    slug: stringField(formData, 'slug'),
    title: stringField(formData, 'title'),
    summary: stringField(formData, 'summary'),
    kind: stringField(formData, 'kind'),
    track: stringField(formData, 'track') ?? 'general',
    status: stringField(formData, 'status') ?? 'draft',
  };
  setIfPresent(body, 'description', stringField(formData, 'description'));
  setIfPresent(body, 'level', stringField(formData, 'level'));
  setIfPresent(body, 'heroImageKey', stringField(formData, 'heroImageKey'));
  const estimatedMinutes = numberField(formData, 'estimatedMinutes');
  if (estimatedMinutes !== null) body['estimatedMinutes'] = estimatedMinutes;
  const passingScorePercent = numberField(formData, 'passingScorePercent');
  if (passingScorePercent !== null) body['passingScorePercent'] = passingScorePercent;

  const validated = CreateAcademyCourseRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const key = `admin-academy-course-create-${randomUUID()}`;
  const result = await callGateway<{ course: { id: string } }>('/api/v1/admin/academy/courses', {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': key },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    redirect(`/academy/courses/${encodeURIComponent(result.body.course.id)}?action=ok`);
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

function numberField(formData: FormData, key: string): number | null {
  const raw = stringField(formData, key);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${LIST_PATH}?action=err&code=${code}`);
}
