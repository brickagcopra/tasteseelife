import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ConciergeOnboardingsListResponseSchema,
  MeResponseSchema,
  type ConciergeOnboardingRecord,
  type ConciergeOnboardingsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { createOnboardingAction } from './actions';
import { readBanner, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Tier 3 onboarding — Taste & See Admin',
};

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

/**
 * Tier-3 onboarding ("white-glove kickoff") list surface (TS-228; PRD §5.1
 * Tier 3; PDD §10.6). Lists the onboardings ops are running, with a progress
 * indicator per household, plus a "start a new onboarding" form.
 *
 * Permission-gated on `concierge:read`; the create form renders only for an
 * actor holding `concierge:write`.
 */
export default async function OnboardingListPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const filterHouseholdId = readString(search, 'householdId');
  const filterStatus = readStatus(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'concierge:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'concierge:write');

  const list = await fetchOnboardings(filterHouseholdId, filterStatus);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Tier 3 onboarding</span>
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
        <h1>Tier 3 onboarding</h1>
        <p>
          Run the white-glove kickoff for new Concierge Lifestyle households — the 30-minute kickoff
          call, senior-preference deep-dive, family expectation-setting, and first-week steps.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/concierge/onboarding"
            method="GET"
            className="user-detail__action-form concierge-event-filter"
          >
            <label className="user-detail__action-label">
              <span>Household ID</span>
              <input name="householdId" defaultValue={filterHouseholdId ?? ''} placeholder="hh_…" />
            </label>
            <label className="user-detail__action-label">
              <span>Status</span>
              <select name="status" defaultValue={filterStatus ?? ''}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'all'} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
        </section>

        {canWrite && (
          <section className="user-detail__section">
            <h2>Start an onboarding</h2>
            <form
              action={createOnboardingAction}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Household ID</span>
                <input
                  name="householdId"
                  required
                  placeholder="hh_…"
                  defaultValue={filterHouseholdId ?? ''}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Kickoff call (UTC, optional)</span>
                <input type="datetime-local" name="kickoffScheduledAt" />
              </label>
              <label className="user-detail__action-label">
                <span>Notes (optional)</span>
                <textarea name="notes" rows={2} placeholder="Family prefers evening calls…" />
              </label>
              <button type="submit" className="user-detail__action-button">
                Start onboarding
              </button>
            </form>
          </section>
        )}

        <section className="user-detail__section">
          <h2>Onboardings</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load onboardings right now. The concierge service may be unreachable.
            </p>
          ) : (
            <OnboardingList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function OnboardingList({
  list,
}: {
  readonly list: ConciergeOnboardingsListResponse;
}): React.JSX.Element {
  if (list.onboardings.length === 0) {
    return (
      <div className="user-empty">
        <p>No onboardings match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.onboardings.map((onboarding) => (
        <OnboardingRow key={onboarding.id} onboarding={onboarding} />
      ))}
    </ul>
  );
}

function OnboardingRow({
  onboarding,
}: {
  readonly onboarding: ConciergeOnboardingRecord;
}): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          className="concierge-event-card__title"
          href={`/concierge/onboarding/${encodeURIComponent(onboarding.id)}`}
        >
          <code>{onboarding.householdId}</code>
        </Link>
        <span className={statusChipClass(onboarding.status)}>{formatLabel(onboarding.status)}</span>
      </div>
      <ProgressBar total={onboarding.stepsTotal} done={onboarding.stepsCompleted} />
      <dl className="concierge-detail__facts">
        {onboarding.kickoffScheduledAt !== null && (
          <FactItem label="Kickoff">{formatDateTime(onboarding.kickoffScheduledAt)}</FactItem>
        )}
        <FactItem label="Started">{formatDateTime(onboarding.createdAt)}</FactItem>
        <FactItem label="Onboarding">
          <Link href={`/concierge/onboarding/${encodeURIComponent(onboarding.id)}`}>
            Open checklist →
          </Link>
        </FactItem>
      </dl>
    </li>
  );
}

function ProgressBar({
  total,
  done,
}: {
  readonly total: number;
  readonly done: number;
}): React.JSX.Element {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="onboarding-progress" aria-label={`${done} of ${total} steps complete`}>
      <div className="onboarding-progress__track">
        <div className="onboarding-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="onboarding-progress__label">
        {done} / {total} steps
      </span>
    </div>
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

function statusChipClass(status: ConciergeOnboardingRecord['status']): string {
  if (status === 'completed') return 'user-row__chip user-row__chip--ok';
  if (status === 'canceled') return 'user-row__chip';
  if (status === 'in_progress') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
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

function readStatus(
  search: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const raw = readString(search, 'status');
  return raw !== undefined && VALID_STATUSES.has(raw) ? raw : undefined;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Onboarding saved.
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
      return 'That household already has an active onboarding. Open the existing one instead.';
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The concierge service is briefly unreachable. Please try again in a moment.';
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

async function fetchOnboardings(
  householdId: string | undefined,
  status: string | undefined,
): Promise<ConciergeOnboardingsListResponse | null> {
  const params = new URLSearchParams();
  if (householdId !== undefined) params.set('householdId', householdId);
  if (status !== undefined) params.set('status', status);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/onboardings${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeOnboardingsListResponseSchema.safeParse(result.body);
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
