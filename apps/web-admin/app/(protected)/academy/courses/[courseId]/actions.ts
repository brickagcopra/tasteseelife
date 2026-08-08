'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AcademyCourseStatusSchema,
  CreateAcademyCohortRequestSchema,
  CreateAcademyLessonRequestSchema,
  CreateAcademyModuleRequestSchema,
  UpdateAcademyCohortRequestSchema,
  UpdateAcademyCourseRequestSchema,
  UpdateAcademyLessonRequestSchema,
  UpdateAcademyModuleRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the Cooking-Academy course catalog-editor DETAIL surface
 * (TS-251-followup-1; PRD §9.5; PDD §10.1, §15.1).
 *
 * Covers every mutation the TS-251 backend exposes:
 *   - course:  update (scalars) · transition (status) · soft-delete
 *   - module:  create · update · delete (cascades lessons)
 *   - lesson:  create · update · delete (204)
 *   - cohort:  create · update · delete (soft-delete)
 *
 * Each re-validates via the contract schema (defence-in-depth), mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), forwards through the gateway BFF (which
 * gates on `academy:write` + re-validates), then revalidates + redirects back to
 * the course detail page with `?action=ok` (or `?action=err&code=…`).
 */

const LIST_PATH = '/academy/courses';
const GW_COURSES = '/api/v1/admin/academy/courses';
const GW_MODULES = '/api/v1/admin/academy/modules';
const GW_LESSONS = '/api/v1/admin/academy/lessons';
const GW_COHORTS = '/api/v1/admin/academy/cohorts';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(courseId: string): string {
  return `${LIST_PATH}/${encodeURIComponent(courseId)}`;
}

// ─── Course ─────────────────────────────────────────────────────────────────

export async function updateCourseAction(courseId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};
  // Non-nullable scalars — an emptied field is invalid input, not a clear.
  for (const field of ['slug', 'title', 'summary', 'kind', 'track'] as const) {
    const value = stringField(formData, field);
    if (value === null) return redirectWithError(courseId, 'invalid-input');
    body[field] = value;
  }
  // Nullable scalars — an empty field clears the value.
  body['description'] = stringField(formData, 'description');
  body['level'] = stringField(formData, 'level');
  body['heroImageKey'] = stringField(formData, 'heroImageKey');
  body['estimatedMinutes'] = numberOrNull(formData, 'estimatedMinutes');
  body['passingScorePercent'] = numberOrNull(formData, 'passingScorePercent');

  const validated = UpdateAcademyCourseRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_COURSES}/${encodeURIComponent(courseId)}`,
    'PATCH',
    validated.data,
    'course-update',
    courseId,
  );
  finish(result, courseId);
}

export async function transitionCourseAction(
  courseId: string,
  status: string,
  _formData: FormData,
): Promise<void> {
  const parsed = AcademyCourseStatusSchema.safeParse(status);
  if (!parsed.success) return redirectWithError(courseId, 'invalid-input');
  const result = await send(
    `${GW_COURSES}/${encodeURIComponent(courseId)}`,
    'PATCH',
    { status: parsed.data },
    'course-transition',
    courseId,
  );
  finish(result, courseId);
}

export async function deleteCourseAction(courseId: string, _formData: FormData): Promise<void> {
  const result = await send(
    `${GW_COURSES}/${encodeURIComponent(courseId)}`,
    'DELETE',
    undefined,
    'course-delete',
    courseId,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(courseId, 'conflict');
    if (result.status === 404) return redirectWithError(courseId, 'not-found');
    return redirectWithError(courseId, 'bad-request');
  }
  return redirectWithError(courseId, 'service-warning');
}

// ─── Module ─────────────────────────────────────────────────────────────────

export async function createModuleAction(courseId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = { title: stringField(formData, 'title') };
  setIfPresent(body, 'description', stringField(formData, 'description'));
  const sortPosition = numberField(formData, 'sortPosition');
  if (sortPosition !== null) body['sortPosition'] = sortPosition;

  const validated = CreateAcademyModuleRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_COURSES}/${encodeURIComponent(courseId)}/modules`,
    'POST',
    validated.data,
    'module-create',
    courseId,
  );
  finish(result, courseId);
}

export async function updateModuleAction(
  courseId: string,
  moduleId: string,
  formData: FormData,
): Promise<void> {
  const title = stringField(formData, 'title');
  if (title === null) return redirectWithError(courseId, 'invalid-input');
  const body: Record<string, unknown> = {
    title,
    description: stringField(formData, 'description'),
  };
  const sortPosition = numberField(formData, 'sortPosition');
  if (sortPosition !== null) body['sortPosition'] = sortPosition;

  const validated = UpdateAcademyModuleRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_MODULES}/${encodeURIComponent(moduleId)}`,
    'PATCH',
    validated.data,
    'module-update',
    courseId,
  );
  finish(result, courseId);
}

export async function deleteModuleAction(
  courseId: string,
  moduleId: string,
  _formData: FormData,
): Promise<void> {
  const result = await send(
    `${GW_MODULES}/${encodeURIComponent(moduleId)}`,
    'DELETE',
    undefined,
    'module-delete',
    courseId,
  );
  finish(result, courseId);
}

// ─── Lesson ─────────────────────────────────────────────────────────────────

export async function createLessonAction(
  courseId: string,
  moduleId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {
    title: stringField(formData, 'title'),
    kind: stringField(formData, 'kind'),
  };
  setIfPresent(body, 'contentKey', stringField(formData, 'contentKey'));
  setIfPresent(body, 'bodyMarkdown', stringField(formData, 'bodyMarkdown'));
  const sortPosition = numberField(formData, 'sortPosition');
  if (sortPosition !== null) body['sortPosition'] = sortPosition;
  const durationMinutes = numberField(formData, 'durationMinutes');
  if (durationMinutes !== null) body['durationMinutes'] = durationMinutes;

  const validated = CreateAcademyLessonRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_MODULES}/${encodeURIComponent(moduleId)}/lessons`,
    'POST',
    validated.data,
    'lesson-create',
    courseId,
  );
  finish(result, courseId);
}

export async function updateLessonAction(
  courseId: string,
  lessonId: string,
  formData: FormData,
): Promise<void> {
  const title = stringField(formData, 'title');
  const kind = stringField(formData, 'kind');
  if (title === null || kind === null) return redirectWithError(courseId, 'invalid-input');
  const body: Record<string, unknown> = {
    title,
    kind,
    contentKey: stringField(formData, 'contentKey'),
    bodyMarkdown: stringField(formData, 'bodyMarkdown'),
    durationMinutes: numberOrNull(formData, 'durationMinutes'),
  };
  const sortPosition = numberField(formData, 'sortPosition');
  if (sortPosition !== null) body['sortPosition'] = sortPosition;

  const validated = UpdateAcademyLessonRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_LESSONS}/${encodeURIComponent(lessonId)}`,
    'PATCH',
    validated.data,
    'lesson-update',
    courseId,
  );
  finish(result, courseId);
}

export async function deleteLessonAction(
  courseId: string,
  lessonId: string,
  _formData: FormData,
): Promise<void> {
  const result = await send(
    `${GW_LESSONS}/${encodeURIComponent(lessonId)}`,
    'DELETE',
    undefined,
    'lesson-delete',
    courseId,
  );
  finish(result, courseId);
}

// ─── Cohort ─────────────────────────────────────────────────────────────────

export async function createCohortAction(courseId: string, formData: FormData): Promise<void> {
  const startsAtLocal = stringField(formData, 'startsAt');
  if (startsAtLocal === null) return redirectWithError(courseId, 'invalid-input');
  const startsAt = localToIso(startsAtLocal);
  if (startsAt === null) return redirectWithError(courseId, 'invalid-input');

  const endsAtLocal = stringField(formData, 'endsAt');
  const endsAt = endsAtLocal === null ? undefined : localToIso(endsAtLocal);
  if (endsAtLocal !== null && endsAt === null) return redirectWithError(courseId, 'invalid-input');

  const body: Record<string, unknown> = {
    name: stringField(formData, 'name'),
    startsAt,
    status: stringField(formData, 'status') ?? 'scheduled',
  };
  if (endsAt !== undefined) body['endsAt'] = endsAt;
  setIfPresent(body, 'instructorUserId', stringField(formData, 'instructorUserId'));
  const capacity = numberField(formData, 'capacity');
  if (capacity !== null) body['capacity'] = capacity;

  const validated = CreateAcademyCohortRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_COURSES}/${encodeURIComponent(courseId)}/cohorts`,
    'POST',
    validated.data,
    'cohort-create',
    courseId,
  );
  finish(result, courseId);
}

export async function updateCohortAction(
  courseId: string,
  cohortId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {};

  const name = stringField(formData, 'name');
  if (name !== null) body['name'] = name;

  const status = stringField(formData, 'status');
  if (status !== null) body['status'] = status;

  const startsAtLocal = stringField(formData, 'startsAt');
  if (startsAtLocal !== null) {
    const iso = localToIso(startsAtLocal);
    if (iso === null) return redirectWithError(courseId, 'invalid-input');
    body['startsAt'] = iso;
  }

  // endsAt is nullable: an empty field clears it (only when the field is present).
  if (formData.has('endsAt')) {
    const endsAtLocal = stringField(formData, 'endsAt');
    if (endsAtLocal === null) {
      body['endsAt'] = null;
    } else {
      const iso = localToIso(endsAtLocal);
      if (iso === null) return redirectWithError(courseId, 'invalid-input');
      body['endsAt'] = iso;
    }
  }

  if (formData.has('capacity')) body['capacity'] = numberOrNull(formData, 'capacity');
  if (formData.has('instructorUserId'))
    body['instructorUserId'] = stringField(formData, 'instructorUserId');

  if (Object.keys(body).length === 0) return redirectWithError(courseId, 'invalid-input');

  const validated = UpdateAcademyCohortRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(courseId, 'invalid-input');

  const result = await send(
    `${GW_COHORTS}/${encodeURIComponent(cohortId)}`,
    'PATCH',
    validated.data,
    'cohort-update',
    courseId,
  );
  finish(result, courseId);
}

export async function deleteCohortAction(
  courseId: string,
  cohortId: string,
  _formData: FormData,
): Promise<void> {
  const result = await send(
    `${GW_COHORTS}/${encodeURIComponent(cohortId)}`,
    'DELETE',
    undefined,
    'cohort-delete',
    courseId,
  );
  finish(result, courseId);
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

async function send(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  surface: string,
  courseId: string,
): Promise<Awaited<ReturnType<typeof callGateway<unknown>>>> {
  const key = `admin-academy-${surface}-${courseId}-${randomUUID()}`;
  return callGateway<unknown>(path, {
    method,
    ...(body !== undefined && { body }),
    headers: { 'idempotency-key': key },
  });
}

function finish(result: Awaited<ReturnType<typeof callGateway<unknown>>>, courseId: string): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath(courseId));
    redirect(`${detailPath(courseId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(courseId, 'conflict');
    if (result.status === 404) return redirectWithError(courseId, 'not-found');
    return redirectWithError(courseId, 'bad-request');
  }
  return redirectWithError(courseId, 'service-warning');
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

/** A nullable numeric field: empty → null (clear); a value → the int. */
function numberOrNull(formData: FormData, key: string): number | null {
  return numberField(formData, key);
}

/** datetime-local (`YYYY-MM-DDTHH:MM(:SS)?`) → ISO UTC string. */
function localToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return null;
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(courseId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(courseId)}?action=err&code=${code}`);
}
