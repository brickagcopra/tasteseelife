import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminJournalsListResponseSchema,
  MeResponseSchema,
  type AdminJournalSummary,
  type AdminJournalsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Journals — Taste & See Admin',
};

const JOURNAL_KINDS = [
  'subscription_activation',
  'subscription_recognition',
  'subscription_cancellation',
  'booking_completion',
  'provider_payout',
  'refund',
  'coupon_redemption',
  'payment_processing_fee',
  'manual_adjustment',
  'period_close',
  'reversal',
] as const;

interface ListFilters {
  readonly periodId: string | null;
  readonly periodName: string | null;
  readonly kind: string | null;
  readonly cursor: string | null;
}

/**
 * Admin journals list (TS-129 Slice 1; PRD §10.8).
 *
 * Cursor-paginated browser with three filters (periodId, periodName,
 * kind). Filters round-trip through the URL so a bookmarked search
 * re-runs on load.
 */
export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasSuperAdminRole(me)) redirect('/dashboard/no-access');

  const filters: ListFilters = {
    periodId: stringParam(params['periodId']),
    periodName: stringParam(params['periodName']),
    kind: stringParam(params['kind']),
    cursor: stringParam(params['cursor']),
  };

  const list = await fetchJournals(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — journals</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/accounting" className="dash-logout">
            ← Accounting
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Journals</h1>
        <p>
          Every posted journal across the financial subsystem. Filter by period or by kind; drill
          into a journal to see its balanced double-entry lines.
        </p>

        <JournalFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the journals list right now. The downstream accounting service may
            be unreachable.
          </p>
        ) : (
          <JournalsTable list={list} filters={filters} />
        )}
      </main>
    </div>
  );
}

function JournalFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/accounting/journals" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Period (YYYY-MM)</span>
        <input
          type="text"
          name="periodName"
          defaultValue={initial.periodName ?? ''}
          placeholder="2026-05"
          autoComplete="off"
          pattern="\d{4}-(0[1-9]|1[0-2])"
        />
      </label>
      <label className="filter-bar__field">
        <span>Period id</span>
        <input
          type="text"
          name="periodId"
          defaultValue={initial.periodId ?? ''}
          placeholder="per_..."
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Kind</span>
        <select name="kind" defaultValue={initial.kind ?? ''}>
          <option value="">Any</option>
          {JOURNAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {formatKind(k)}
            </option>
          ))}
        </select>
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply filters
        </button>
        <Link href="/accounting/journals" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

function JournalsTable({
  list,
  filters,
}: {
  readonly list: AdminJournalsListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (list.journals.length === 0) {
    return (
      <div className="user-empty">
        <p>No journals match these filters.</p>
      </div>
    );
  }

  return (
    <>
      <div className="user-table" role="table" aria-label="Journals">
        <div className="user-table__head" role="row">
          <span role="columnheader">Kind</span>
          <span role="columnheader">Period</span>
          <span role="columnheader">Occurred</span>
          <span role="columnheader">DR / CR</span>
          <span role="columnheader">Lines</span>
        </div>
        {list.journals.map((journal) => (
          <JournalRow key={journal.id} journal={journal} />
        ))}
      </div>
      <Pagination cursor={list.nextCursor} filters={filters} />
    </>
  );
}

function JournalRow({ journal }: { readonly journal: AdminJournalSummary }): React.JSX.Element {
  return (
    <Link
      key={journal.id}
      href={`/accounting/journals/${encodeURIComponent(journal.id)}`}
      className="user-row"
      role="row"
    >
      <span role="cell">
        <span className="user-row__email">{formatKind(journal.kind)}</span>
        {journal.reversedByJournalId !== null && <span className="user-row__chip">reversed</span>}
        {journal.reversedJournalId !== null && <span className="user-row__chip">reversal</span>}
      </span>
      <span role="cell">{journal.periodName}</span>
      <span role="cell" className="user-row__date">
        {formatDateTime(journal.occurredAt)}
      </span>
      <span role="cell">
        {formatMoney(journal.totalDebitMinor, journal.currency)} /{' '}
        {formatMoney(journal.totalCreditMinor, journal.currency)}
      </span>
      <span role="cell">{journal.lineCount}</span>
    </Link>
  );
}

function Pagination({
  cursor,
  filters,
}: {
  readonly cursor: string | null;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (cursor === null) {
    return <p className="user-pagination">End of list.</p>;
  }
  const params = new URLSearchParams();
  if (filters.periodId !== null) params.set('periodId', filters.periodId);
  if (filters.periodName !== null) params.set('periodName', filters.periodName);
  if (filters.kind !== null) params.set('kind', filters.kind);
  params.set('cursor', cursor);
  return (
    <p className="user-pagination">
      <Link href={`/accounting/journals?${params.toString()}`} className="filter-bar__submit">
        Next page →
      </Link>
    </p>
  );
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

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchJournals(filters: ListFilters): Promise<AdminJournalsListResponse | null> {
  const query = new URLSearchParams();
  if (filters.periodId !== null) query.set('periodId', filters.periodId);
  if (filters.periodName !== null) query.set('periodName', filters.periodName);
  if (filters.kind !== null) query.set('kind', filters.kind);
  if (filters.cursor !== null) query.set('cursor', filters.cursor);
  query.set('limit', '25');

  const result = await callGateway<unknown>(`/api/v1/admin/journals?${query.toString()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminJournalsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function formatKind(kind: AdminJournalSummary['kind']): string {
  const words = kind.split('_');
  return words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}
