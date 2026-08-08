import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AcademyCoursesListResponseSchema,
  MeResponseSchema,
  type AcademyCourseRecord,
  type AcademyCoursesListResponse,
  type AcademyCourseStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { createCourseAction } from './actions';
import { readBanner, readEnum, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Cooking Academy — course catalog — Taste & See Admin',
};

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
] as const;

const INITIAL_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft (compose buffer)' },
  { value: 'published', label: 'Published (live immediately)' },
] as const;

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

const VALID_STATUSES = new Set<string>(STATUS_OPTIONS.map((s) => s.value));
const VALID_TRACKS = new Set<string>(TRACK_OPTIONS.map((t) => t.value));
const VALID_KINDS = new Set<string>(KIND_OPTIONS.map((k) => k.value));

/**
 * Cooking-Academy course-catalog admin surface (TS-251-followup-1; PRD §9.5;
 * PDD §10.1; PDD §15.1). The web-admin half of the TS-251 backend: list the
 * catalog (filtered by status / track / kind), create a course, and drill into
 * a course's catalog-editor tree.
 *
 * Permission-gated on `academy:read`; the create form renders only for an actor
 * holding `academy:write` (the gateway BFF + service-academy enforce the gate —
 * this is a UI-affordance gate). Mirrors the TS-227 concierge scheduled-events
 * surface one-for-one.
 */
export default async function CoursesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const filterStatus = readEnum(search, 'status', VALID_STATUSES);
  const filterTrack = readEnum(search, 'track', VALID_TRACKS);
  const filterKind = readEnum(search, 'kind', VALID_KINDS);
  const includeDeleted = readString(search, 'includeDeleted') === 'true';

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

  const list = await fetchCourses(filterStatus, filterTrack, filterKind, includeDeleted);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Cooking Academy course catalog</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Cooking Academy — course catalog</h1>
        <p>
          Author and curate the Academy curriculum. Create a course, then open it to build its
          module &rarr; lesson tree and schedule cohorts. Courses move draft &rarr; published &rarr;
          archived; an archived course is preserved for existing enrollments.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/academy/courses"
            method="GET"
            className="user-detail__action-form concierge-event-filter"
          >
            <label className="user-detail__action-label">
              <span>Status</span>
              <select name="status" defaultValue={filterStatus ?? ''}>
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Track</span>
              <select name="track" defaultValue={filterTrack ?? ''}>
                <option value="">All tracks</option>
                {TRACK_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Kind</span>
              <select name="kind" defaultValue={filterKind ?? ''}>
                <option value="">All kinds</option>
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Include deleted</span>
              <select name="includeDeleted" defaultValue={includeDeleted ? 'true' : ''}>
                <option value="">Live only</option>
                <option value="true">Include soft-deleted</option>
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
        </section>

        {canWrite && (
          <section className="user-detail__section">
            <h2>Create a course</h2>
            <CreateCourseForm />
          </section>
        )}

        <section className="user-detail__section">
          <h2>Courses</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load the catalog right now. The academy service may be unreachable.
            </p>
          ) : (
            <CourseList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function CourseList({ list }: { readonly list: AcademyCoursesListResponse }): React.JSX.Element {
  if (list.courses.length === 0) {
    return (
      <div className="user-empty">
        <p>No courses match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.courses.map((course) => (
        <CourseRow key={course.id} course={course} />
      ))}
    </ul>
  );
}

function CourseRow({ course }: { readonly course: AcademyCourseRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/academy/courses/${encodeURIComponent(course.id)}`}
          className="concierge-event-card__title"
        >
          {course.title}
        </Link>
        <span className={statusChipClass(course.status)}>{formatLabel(course.status)}</span>
        <span className="user-row__chip">{formatLabel(course.track)}</span>
        <span className="user-row__chip">{formatLabel(course.kind)}</span>
        {course.deletedAt !== null && <span className="user-row__chip">deleted</span>}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Slug">
          <code>{course.slug}</code>
        </FactItem>
        <FactItem label="Summary">{course.summary}</FactItem>
        {course.estimatedMinutes !== null && (
          <FactItem label="Est. duration">{course.estimatedMinutes} min</FactItem>
        )}
        {course.passingScorePercent !== null && (
          <FactItem label="Pass mark">{course.passingScorePercent}%</FactItem>
        )}
        <FactItem label="Updated">{formatDateTime(course.updatedAt)}</FactItem>
      </dl>
      <p className="user-detail__hint">
        <Link href={`/academy/courses/${encodeURIComponent(course.id)}`}>
          Open catalog editor →
        </Link>
      </p>
    </li>
  );
}

function CreateCourseForm(): React.JSX.Element {
  return (
    <form action={createCourseAction} className="user-detail__action-form concierge-event-form">
      <label className="user-detail__action-label">
        <span>Title</span>
        <input name="title" required placeholder="Dementia-sensitive dining foundations" />
      </label>
      <label className="user-detail__action-label">
        <span>Slug (lowercase-kebab)</span>
        <input name="slug" required placeholder="dementia-sensitive-dining-foundations" />
      </label>
      <label className="user-detail__action-label">
        <span>Summary</span>
        <input
          name="summary"
          required
          placeholder="Short catalog blurb shown on the course card."
        />
      </label>
      <label className="user-detail__action-label">
        <span>Description (Markdown, optional)</span>
        <textarea name="description" rows={3} placeholder="Full course description…" />
      </label>
      <label className="user-detail__action-label">
        <span>Kind</span>
        <select name="kind" defaultValue={KIND_OPTIONS[0].value}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Track</span>
        <select name="track" defaultValue="general">
          {TRACK_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Level (optional)</span>
        <input name="level" placeholder="beginner" />
      </label>
      <label className="user-detail__action-label">
        <span>Estimated minutes (optional)</span>
        <input type="number" name="estimatedMinutes" min={0} />
      </label>
      <label className="user-detail__action-label">
        <span>Hero image key (media-svc, optional)</span>
        <input name="heroImageKey" placeholder="academy/heroes/…" />
      </label>
      <label className="user-detail__action-label">
        <span>Passing score % (optional)</span>
        <input type="number" name="passingScorePercent" min={0} max={100} />
      </label>
      <label className="user-detail__action-label">
        <span>Initial status</span>
        <select name="status" defaultValue="draft">
          {INITIAL_STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="user-detail__action-button">
        Create course
      </button>
    </form>
  );
}

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

function statusChipClass(status: AcademyCourseStatus): string {
  return status === 'published' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Course saved.
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
      return 'The form input was invalid. Check the fields (slug must be lowercase-kebab) and try again.';
    case 'conflict':
      return 'That slug is already taken by another course. Choose a different slug.';
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

async function fetchCourses(
  status: string | undefined,
  track: string | undefined,
  kind: string | undefined,
  includeDeleted: boolean,
): Promise<AcademyCoursesListResponse | null> {
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (track !== undefined) params.set('track', track);
  if (kind !== undefined) params.set('kind', kind);
  if (includeDeleted) params.set('includeDeleted', 'true');
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/academy/courses${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AcademyCoursesListResponseSchema.safeParse(result.body);
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
