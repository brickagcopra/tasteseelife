import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ConciergeEnrichmentSummariesListResponseSchema,
  MeResponseSchema,
  type ConciergeEnrichmentSummaryRecord,
  type ConciergeEnrichmentSummariesListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { createEnrichmentSummaryAction } from './actions';
import { readBanner, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Tier 3 enrichment summaries — Taste & See Admin',
};

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

/**
 * Tier-3 weekly enrichment-summary list surface (TS-229; PRD §5.1 Tier 3,
 * §6.9). Lists the summaries ops have written per household + a "write a new
 * weekly summary" form. Permission-gated on `concierge:read`; the create form
 * renders only for an actor holding `concierge:write`.
 */
export default async function EnrichmentSummariesListPage({
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

  const list = await fetchSummaries(filterHouseholdId, filterStatus);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Tier 3 enrichment summaries</span>
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
        <h1>Tier 3 enrichment summaries</h1>
        <p>
          Write the weekly white-glove recap for a Concierge Lifestyle household — visit highlights,
          wellness signals, and social engagement. Drafts stay private; published summaries appear
          on the family dashboard.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/concierge/enrichment-summaries"
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
            <h2>Write a weekly summary</h2>
            <form
              action={createEnrichmentSummaryAction}
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
                <span>Week starting (a Monday)</span>
                <input
                  type="date"
                  name="weekStartDate"
                  required
                  defaultValue={mostRecentMonday()}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Headline</span>
                <input
                  name="headline"
                  required
                  placeholder="A warm week of good food and company"
                />
              </label>
              <label className="user-detail__action-label">
                <span>Visit highlights</span>
                <textarea
                  name="visitHighlights"
                  rows={3}
                  required
                  placeholder="Visits this week…"
                />
              </label>
              <label className="user-detail__action-label">
                <span>Wellness signals</span>
                <textarea
                  name="wellnessSignals"
                  rows={3}
                  required
                  placeholder="Mood, appetite, mobility…"
                />
              </label>
              <label className="user-detail__action-label">
                <span>Social engagement</span>
                <textarea
                  name="socialEngagement"
                  rows={3}
                  required
                  placeholder="Outings, companionship…"
                />
              </label>
              <label className="user-detail__action-label">
                <span>Additional notes (optional)</span>
                <textarea
                  name="additionalNotes"
                  rows={2}
                  placeholder="Anything else for the family…"
                />
              </label>
              <button type="submit" className="user-detail__action-button">
                Save draft
              </button>
            </form>
          </section>
        )}

        <section className="user-detail__section">
          <h2>Summaries</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load summaries right now. The concierge service may be unreachable.
            </p>
          ) : (
            <SummaryList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function SummaryList({
  list,
}: {
  readonly list: ConciergeEnrichmentSummariesListResponse;
}): React.JSX.Element {
  if (list.summaries.length === 0) {
    return (
      <div className="user-empty">
        <p>No summaries match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.summaries.map((summary) => (
        <SummaryRow key={summary.id} summary={summary} />
      ))}
    </ul>
  );
}

function SummaryRow({
  summary,
}: {
  readonly summary: ConciergeEnrichmentSummaryRecord;
}): React.JSX.Element {
  const href = `/concierge/enrichment-summaries/${encodeURIComponent(summary.id)}`;
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link className="concierge-event-card__title" href={href}>
          {summary.headline}
        </Link>
        <span className={statusChipClass(summary.status)}>{summary.status}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Household">
          <code>{summary.householdId}</code>
        </FactItem>
        <FactItem label="Week of">{formatDate(summary.weekStartDate)}</FactItem>
        <FactItem label="Summary">
          <Link href={href}>Open summary →</Link>
        </FactItem>
      </dl>
    </li>
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

function statusChipClass(status: ConciergeEnrichmentSummaryRecord['status']): string {
  return status === 'published' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function formatDate(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00.000Z`).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

/** The most recent Monday (UTC) as a `YYYY-MM-DD` default for the create form. */
function mostRecentMonday(): string {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utc.getUTCDay(); // 0 = Sun … 1 = Mon
  const delta = (day + 6) % 7; // days since the most recent Monday
  utc.setUTCDate(utc.getUTCDate() - delta);
  return utc.toISOString().slice(0, 10);
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
        Summary saved.
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
      return 'The form input was invalid — the week starting date must be a Monday. Check the fields and try again.';
    case 'conflict':
      return 'That household already has a summary for that week. Open the existing one to edit it.';
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

async function fetchSummaries(
  householdId: string | undefined,
  status: string | undefined,
): Promise<ConciergeEnrichmentSummariesListResponse | null> {
  const params = new URLSearchParams();
  if (householdId !== undefined) params.set('householdId', householdId);
  if (status !== undefined) params.set('status', status);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/enrichment-summaries${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeEnrichmentSummariesListResponseSchema.safeParse(result.body);
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
