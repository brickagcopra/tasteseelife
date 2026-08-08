import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ACADEMY_COHORT_STATUS_TRANSITIONS,
  ACADEMY_COURSE_STATUS_TRANSITIONS,
  AcademyCohortsListResponseSchema,
  AcademyCourseDetailResponseSchema,
  MeResponseSchema,
  isAcademyCohortTerminal,
  type AcademyCohortRecord,
  type AcademyCohortStatus,
  type AcademyCohortsListResponse,
  type AcademyCourseDetail,
  type AcademyCourseModuleWithLessons,
  type AcademyCourseStatus,
  type AcademyLessonRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import {
  createCohortAction,
  createLessonAction,
  createModuleAction,
  deleteCohortAction,
  deleteCourseAction,
  deleteLessonAction,
  deleteModuleAction,
  transitionCourseAction,
  updateCohortAction,
  updateCourseAction,
  updateLessonAction,
  updateModuleAction,
} from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Course catalog editor — Taste & See Admin',
};

const TRACK_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'dementia_sensitive', label: 'Dementia-sensitive dining' },
  { value: 'therapeutic_meals', label: 'Therapeutic meals' },
  { value: 'luxury_in_home', label: 'Luxury in-home service' },
  { value: 'cultural_comfort_cuisine', label: 'Cultural comfort cuisine' },
] as const;

const KIND_OPTIONS = [
  { value: 'self_paced', label: 'Self-paced' },
  { value: 'cohort_based', label: 'Cohort-based' },
  { value: 'in_person_workshop', label: 'In-person workshop' },
] as const;

const LESSON_KIND_OPTIONS = [
  { value: 'video', label: 'Video' },
  { value: 'reading', label: 'Reading' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'assignment', label: 'Assignment' },
] as const;

const COURSE_STATUS_LABELS: Record<AcademyCourseStatus, string> = {
  draft: 'Move to draft',
  published: 'Publish',
  archived: 'Archive',
};

/**
 * Cooking-Academy course catalog-editor (TS-251-followup-1; PRD §9.5; PDD
 * §10.1, §15.1). Hydrates the full course tree (course + ordered modules +
 * their ordered lessons) plus the course's cohorts, and exposes every TS-251
 * mutation: edit / transition / delete the course, manage its module → lesson
 * tree, and schedule / drive its cohorts.
 *
 * Permission-gated on `academy:read`; write affordances render only for an actor
 * holding `academy:write`. Cohort times are entered + shown in UTC.
 */
export default async function CourseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { courseId } = await params;
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'academy:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'academy:write');

  const course = await fetchCourse(courseId);
  const cohorts = course === null ? null : await fetchCohorts(courseId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Cooking Academy catalog editor</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/academy/courses" className="dash-logout">
            Back to catalog
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Course catalog editor</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {course === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that course — it may have been removed, or the academy service is
            unreachable.
          </p>
        ) : (
          <>
            <CourseSection course={course} canWrite={canWrite} />
            <ModulesSection course={course} canWrite={canWrite} />
            <CohortsSection courseId={course.id} cohorts={cohorts} canWrite={canWrite} />
          </>
        )}
      </main>
    </div>
  );
}

// ─── Course ─────────────────────────────────────────────────────────────────

function CourseSection({
  course,
  canWrite,
}: {
  readonly course: AcademyCourseDetail;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{course.title}</span>
        <span className={courseStatusChipClass(course.status)}>{formatLabel(course.status)}</span>
        <span className="user-row__chip">{formatLabel(course.track)}</span>
        <span className="user-row__chip">{formatLabel(course.kind)}</span>
        {course.deletedAt !== null && <span className="user-row__chip">deleted</span>}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Slug">
          <code>{course.slug}</code>
        </FactItem>
        <FactItem label="Summary">{course.summary}</FactItem>
        {course.description !== null && (
          <FactItem label="Description">{course.description}</FactItem>
        )}
        {course.level !== null && <FactItem label="Level">{course.level}</FactItem>}
        {course.estimatedMinutes !== null && (
          <FactItem label="Est. duration">{course.estimatedMinutes} min</FactItem>
        )}
        {course.passingScorePercent !== null && (
          <FactItem label="Pass mark">{course.passingScorePercent}%</FactItem>
        )}
        {course.heroImageKey !== null && (
          <FactItem label="Hero image">
            <code>{course.heroImageKey}</code>
          </FactItem>
        )}
        <FactItem label="Updated">{formatDateTime(course.updatedAt)}</FactItem>
      </dl>

      {canWrite && (
        <>
          <div className="enrichment-transitions">
            {ACADEMY_COURSE_STATUS_TRANSITIONS[course.status].map((to) => (
              <form key={to} action={transitionCourseAction.bind(null, course.id, to)}>
                <button
                  type="submit"
                  className={
                    to === 'archived'
                      ? 'user-detail__action-button user-detail__action-button--danger'
                      : 'user-detail__action-button'
                  }
                >
                  {COURSE_STATUS_LABELS[to]}
                </button>
              </form>
            ))}
          </div>

          <div className="concierge-event-update">
            <h3 className="enrichment-section__title">Edit course</h3>
            <CourseEditForm course={course} />
          </div>

          {course.deletedAt === null && (
            <form
              action={deleteCourseAction.bind(null, course.id)}
              className="onboarding-cancel-form"
            >
              <button
                type="submit"
                className="user-detail__action-button user-detail__action-button--danger"
              >
                Delete course (soft-delete)
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function CourseEditForm({ course }: { readonly course: AcademyCourseDetail }): React.JSX.Element {
  return (
    <form
      action={updateCourseAction.bind(null, course.id)}
      className="user-detail__action-form concierge-event-form"
    >
      <label className="user-detail__action-label">
        <span>Title</span>
        <input name="title" defaultValue={course.title} />
      </label>
      <label className="user-detail__action-label">
        <span>Slug</span>
        <input name="slug" defaultValue={course.slug} />
      </label>
      <label className="user-detail__action-label">
        <span>Summary</span>
        <input name="summary" defaultValue={course.summary} />
      </label>
      <label className="user-detail__action-label">
        <span>Description (empty clears)</span>
        <textarea name="description" rows={3} defaultValue={course.description ?? ''} />
      </label>
      <label className="user-detail__action-label">
        <span>Kind</span>
        <select name="kind" defaultValue={course.kind}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Track</span>
        <select name="track" defaultValue={course.track}>
          {TRACK_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Level (empty clears)</span>
        <input name="level" defaultValue={course.level ?? ''} />
      </label>
      <label className="user-detail__action-label">
        <span>Estimated minutes (empty clears)</span>
        <input
          type="number"
          name="estimatedMinutes"
          min={0}
          defaultValue={course.estimatedMinutes ?? ''}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Hero image key (empty clears)</span>
        <input name="heroImageKey" defaultValue={course.heroImageKey ?? ''} />
      </label>
      <label className="user-detail__action-label">
        <span>Passing score % (empty clears)</span>
        <input
          type="number"
          name="passingScorePercent"
          min={0}
          max={100}
          defaultValue={course.passingScorePercent ?? ''}
        />
      </label>
      <button type="submit" className="user-detail__action-button">
        Save course
      </button>
    </form>
  );
}

// ─── Modules + lessons ────────────────────────────────────────────────────────

function ModulesSection({
  course,
  canWrite,
}: {
  readonly course: AcademyCourseDetail;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Modules &amp; lessons</h2>
      {course.modules.length === 0 ? (
        <div className="user-empty">
          <p>This course has no modules yet.</p>
        </div>
      ) : (
        <ul className="academy-tree">
          {course.modules.map((module) => (
            <ModuleCard key={module.id} courseId={course.id} module={module} canWrite={canWrite} />
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="concierge-event-update">
          <h3 className="enrichment-section__title">Add a module</h3>
          <form
            action={createModuleAction.bind(null, course.id)}
            className="user-detail__action-form concierge-event-form"
          >
            <label className="user-detail__action-label">
              <span>Title</span>
              <input name="title" required placeholder="Module 1 — Foundations" />
            </label>
            <label className="user-detail__action-label">
              <span>Description (optional)</span>
              <textarea name="description" rows={2} />
            </label>
            <label className="user-detail__action-label">
              <span>Sort position (optional — appended if omitted)</span>
              <input type="number" name="sortPosition" min={0} />
            </label>
            <button type="submit" className="user-detail__action-button">
              Add module
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function ModuleCard({
  courseId,
  module,
  canWrite,
}: {
  readonly courseId: string;
  readonly module: AcademyCourseModuleWithLessons;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <li className="academy-module">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{module.title}</span>
        <span className="user-row__chip">position {module.sortPosition}</span>
        <span className="user-row__chip">{module.lessons.length} lessons</span>
      </div>
      {module.description !== null && (
        <p className="onboarding-step__description">{module.description}</p>
      )}

      {module.lessons.length === 0 ? (
        <p className="user-detail__hint">No lessons in this module yet.</p>
      ) : (
        <ul className="academy-lesson-list">
          {module.lessons.map((lesson) => (
            <LessonRow key={lesson.id} courseId={courseId} lesson={lesson} canWrite={canWrite} />
          ))}
        </ul>
      )}

      {canWrite && (
        <>
          <details className="academy-disclosure">
            <summary>Add a lesson</summary>
            <form
              action={createLessonAction.bind(null, courseId, module.id)}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Title</span>
                <input name="title" required placeholder="Welcome &amp; orientation" />
              </label>
              <label className="user-detail__action-label">
                <span>Kind</span>
                <select name="kind" defaultValue={LESSON_KIND_OPTIONS[0].value}>
                  {LESSON_KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="user-detail__action-label">
                <span>Content key (video — media-svc, optional)</span>
                <input name="contentKey" placeholder="academy/lessons/…" />
              </label>
              <label className="user-detail__action-label">
                <span>Body Markdown (reading, optional)</span>
                <textarea name="bodyMarkdown" rows={3} />
              </label>
              <label className="user-detail__action-label">
                <span>Duration minutes (optional)</span>
                <input type="number" name="durationMinutes" min={1} />
              </label>
              <label className="user-detail__action-label">
                <span>Sort position (optional — appended if omitted)</span>
                <input type="number" name="sortPosition" min={0} />
              </label>
              <button type="submit" className="user-detail__action-button">
                Add lesson
              </button>
            </form>
          </details>

          <details className="academy-disclosure">
            <summary>Edit module</summary>
            <form
              action={updateModuleAction.bind(null, courseId, module.id)}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Title</span>
                <input name="title" defaultValue={module.title} />
              </label>
              <label className="user-detail__action-label">
                <span>Description (empty clears)</span>
                <textarea name="description" rows={2} defaultValue={module.description ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Sort position</span>
                <input
                  type="number"
                  name="sortPosition"
                  min={0}
                  defaultValue={module.sortPosition}
                />
              </label>
              <button type="submit" className="user-detail__action-button">
                Save module
              </button>
            </form>
          </details>

          <form
            action={deleteModuleAction.bind(null, courseId, module.id)}
            className="onboarding-cancel-form"
          >
            <button
              type="submit"
              className="user-detail__action-button user-detail__action-button--danger"
            >
              Delete module ({module.lessons.length} lessons cascade)
            </button>
          </form>
        </>
      )}
    </li>
  );
}

function LessonRow({
  courseId,
  lesson,
  canWrite,
}: {
  readonly courseId: string;
  readonly lesson: AcademyLessonRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <li className="academy-lesson">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{lesson.title}</span>
        <span className="user-row__chip">{formatLabel(lesson.kind)}</span>
        <span className="user-row__chip">position {lesson.sortPosition}</span>
        {lesson.durationMinutes !== null && (
          <span className="user-row__chip">{lesson.durationMinutes} min</span>
        )}
      </div>
      {canWrite && (
        <>
          <details className="academy-disclosure">
            <summary>Edit lesson</summary>
            <form
              action={updateLessonAction.bind(null, courseId, lesson.id)}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Title</span>
                <input name="title" defaultValue={lesson.title} />
              </label>
              <label className="user-detail__action-label">
                <span>Kind</span>
                <select name="kind" defaultValue={lesson.kind}>
                  {LESSON_KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="user-detail__action-label">
                <span>Content key (empty clears)</span>
                <input name="contentKey" defaultValue={lesson.contentKey ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Body Markdown (empty clears)</span>
                <textarea name="bodyMarkdown" rows={3} defaultValue={lesson.bodyMarkdown ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Duration minutes (empty clears)</span>
                <input
                  type="number"
                  name="durationMinutes"
                  min={1}
                  defaultValue={lesson.durationMinutes ?? ''}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Sort position</span>
                <input
                  type="number"
                  name="sortPosition"
                  min={0}
                  defaultValue={lesson.sortPosition}
                />
              </label>
              <button type="submit" className="user-detail__action-button">
                Save lesson
              </button>
            </form>
          </details>
          <form
            action={deleteLessonAction.bind(null, courseId, lesson.id)}
            className="onboarding-cancel-form"
          >
            <button
              type="submit"
              className="user-detail__action-button user-detail__action-button--danger"
            >
              Delete lesson
            </button>
          </form>
        </>
      )}
    </li>
  );
}

// ─── Cohorts ─────────────────────────────────────────────────────────────────

function CohortsSection({
  courseId,
  cohorts,
  canWrite,
}: {
  readonly courseId: string;
  readonly cohorts: AcademyCohortsListResponse | null;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Cohorts</h2>
      {cohorts === null ? (
        <p className="auth-alert" role="alert">
          We couldn&apos;t load this course&apos;s cohorts right now.
        </p>
      ) : cohorts.cohorts.length === 0 ? (
        <div className="user-empty">
          <p>No cohorts scheduled for this course.</p>
        </div>
      ) : (
        <ul className="concierge-event-list">
          {cohorts.cohorts.map((cohort) => (
            <CohortRow key={cohort.id} courseId={courseId} cohort={cohort} canWrite={canWrite} />
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="concierge-event-update">
          <h3 className="enrichment-section__title">Schedule a cohort</h3>
          <form
            action={createCohortAction.bind(null, courseId)}
            className="user-detail__action-form concierge-event-form"
          >
            <label className="user-detail__action-label">
              <span>Name</span>
              <input name="name" required placeholder="Spring 2026 — Tuesday evenings" />
            </label>
            <label className="user-detail__action-label">
              <span>Starts (UTC)</span>
              <input type="datetime-local" name="startsAt" required />
            </label>
            <label className="user-detail__action-label">
              <span>Ends (UTC, optional)</span>
              <input type="datetime-local" name="endsAt" />
            </label>
            <label className="user-detail__action-label">
              <span>Capacity (optional)</span>
              <input type="number" name="capacity" min={1} />
            </label>
            <label className="user-detail__action-label">
              <span>Instructor user ID (optional)</span>
              <input name="instructorUserId" placeholder="usr_…" />
            </label>
            <label className="user-detail__action-label">
              <span>Initial status</span>
              <select name="status" defaultValue="scheduled">
                <option value="scheduled">Scheduled</option>
                <option value="open">Open for enrollment</option>
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Schedule cohort
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function CohortRow({
  courseId,
  cohort,
  canWrite,
}: {
  readonly courseId: string;
  readonly cohort: AcademyCohortRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  const terminal = isAcademyCohortTerminal(cohort.status);
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{cohort.name}</span>
        <span className={cohortStatusChipClass(cohort.status)}>{formatLabel(cohort.status)}</span>
        {cohort.deletedAt !== null && <span className="user-row__chip">deleted</span>}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="When">{formatRange(cohort.startsAt, cohort.endsAt)}</FactItem>
        {cohort.capacity !== null && <FactItem label="Capacity">{cohort.capacity}</FactItem>}
        {cohort.instructorUserId !== null && (
          <FactItem label="Instructor">
            <code>{cohort.instructorUserId}</code>
          </FactItem>
        )}
      </dl>

      {canWrite && !terminal && (
        <>
          <details className="academy-disclosure">
            <summary>Edit cohort</summary>
            <form
              action={updateCohortAction.bind(null, courseId, cohort.id)}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Name</span>
                <input name="name" defaultValue={cohort.name} />
              </label>
              <label className="user-detail__action-label">
                <span>Status</span>
                <select name="status" defaultValue={cohort.status}>
                  <option value={cohort.status}>{formatLabel(cohort.status)} (unchanged)</option>
                  {ACADEMY_COHORT_STATUS_TRANSITIONS[cohort.status].map((to) => (
                    <option key={to} value={to}>
                      → {formatLabel(to)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="user-detail__action-label">
                <span>Starts (UTC)</span>
                <input
                  type="datetime-local"
                  name="startsAt"
                  defaultValue={toLocalInput(cohort.startsAt)}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Ends (UTC, empty clears)</span>
                <input
                  type="datetime-local"
                  name="endsAt"
                  defaultValue={cohort.endsAt === null ? '' : toLocalInput(cohort.endsAt)}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Capacity (empty clears)</span>
                <input type="number" name="capacity" min={1} defaultValue={cohort.capacity ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Instructor user ID (empty clears)</span>
                <input name="instructorUserId" defaultValue={cohort.instructorUserId ?? ''} />
              </label>
              <button type="submit" className="user-detail__action-button">
                Save cohort
              </button>
            </form>
          </details>
          <form
            action={deleteCohortAction.bind(null, courseId, cohort.id)}
            className="onboarding-cancel-form"
          >
            <button
              type="submit"
              className="user-detail__action-button user-detail__action-button--danger"
            >
              Delete cohort (soft-delete)
            </button>
          </form>
        </>
      )}
      {canWrite && terminal && (
        <p className="user-detail__hint">
          This cohort is {formatLabel(cohort.status)} — no further edits are available.
        </p>
      )}
    </li>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function FactItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="concierge-detail__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function courseStatusChipClass(status: AcademyCourseStatus): string {
  return status === 'published' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function cohortStatusChipClass(status: AcademyCohortStatus): string {
  if (status === 'in_progress' || status === 'open') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatMaybeDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function formatDateTime(iso: string): string {
  return formatMaybeDate(iso);
}

function formatRange(start: string, end: string | null): string {
  const startText = formatMaybeDate(start);
  return end === null ? `${startText} UTC` : `${startText} – ${formatMaybeDate(end)} UTC`;
}

/** ISO (UTC) → `YYYY-MM-DDTHH:MM` for a datetime-local input default. */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Saved.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      {bannerMessageFor(banner.code)}
    </p>
  );
}

function bannerMessageFor(code: string): string {
  switch (code) {
    case 'invalid-input':
      return 'The form input was invalid. Check the fields and try again.';
    case 'conflict':
      return 'That change is not allowed in the current state (e.g. an invalid status transition, a duplicate slug, or a course that still has cohorts).';
    case 'not-found':
      return "We couldn't find that record — it may have been removed.";
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The academy service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchCourse(courseId: string): Promise<AcademyCourseDetail | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AcademyCourseDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.course : null;
}

async function fetchCohorts(courseId: string): Promise<AcademyCohortsListResponse | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/academy/courses/${encodeURIComponent(courseId)}/cohorts`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AcademyCohortsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>
        Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
        our team is already on it.
      </p>
    </main>
  );
}
