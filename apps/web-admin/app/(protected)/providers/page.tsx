import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  PROVIDER_DIRECTORY_LIMIT_DEFAULT,
  ProviderDirectoryListResponseSchema,
  type MeResponse,
  type ProviderDirectoryListResponse,
  type ProviderDirectoryRow,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readOffset } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Providers — Taste & See Admin',
};

/**
 * Provider directory (TS-305c-followup-1; PRD §10.14, PDD §16.1).
 *
 * The way IN to the Provider 360. Until this page existed, the 360 was
 * reachable only from an incident that already named a provider — so a
 * committee convened about someone by name had no entry point, and
 * neither did a routine tier review, which is the common case and by
 * definition has no incident behind it.
 *
 * **Gated on `provider:read` alone**, which is a weaker gate than the
 * 360 it links into (`provider:read` AND `trust_safety:write`). That is
 * deliberate: `provider_ops` holds `provider:read` and does real work
 * against this list — finding a provider to check a credential or a
 * tier — without ever being a member of the review committee. Locking
 * the directory to the committee's gate would take a routine ops tool
 * away from the team that uses it most.
 *
 * The consequence is that some viewers cannot open the 360, so **a row
 * is a LINK only when the viewer holds both permissions.** Everyone
 * else gets the same row as plain text plus one line saying why. A
 * link that always bounces to /dashboard/no-access reads as a broken
 * console rather than as a boundary — the rule TS-303c2b-followup-2
 * established on the incident queue, applied again here.
 *
 * **Archived providers are excluded unless asked for, and always
 * badged.** The directory is a working set; an operator looking for
 * someone they suspect was archived turns the filter on, and when they
 * do, the archived rows are marked rather than blended in.
 */

const STATUS_OPTIONS = ['pending', 'in_review', 'active', 'suspended', 'archived'] as const;
const TIER_OPTIONS = ['basic', 'certified', 'elite'] as const;

interface ListFilters {
  readonly q: string | null;
  readonly status: string | null;
  readonly tier: string | null;
  readonly includeArchived: boolean;
  readonly offset: number;
}

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
        </main>
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'provider:read')) redirect('/dashboard/no-access');

  const canOpen360 = hasPermission(me, 'trust_safety:write');

  const filters: ListFilters = {
    q: stringParam(params['q']),
    status: stringParam(params['status']),
    tier: stringParam(params['tier']),
    includeArchived: stringParam(params['includeArchived']) === 'true',
    offset: readOffset(params['offset']),
  };

  const list = await fetchProviders(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — providers</span>
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
        <h1>Providers</h1>
        <p>
          Search the provider roster by name, status, and tier. Read-only — credential and tier
          changes are made from the provider&apos;s own record.
        </p>

        <ProviderFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the provider directory. The provider service may be unreachable —
            do not read this as an empty roster.
          </p>
        ) : (
          <ProviderTable list={list} filters={filters} canOpen360={canOpen360} />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────

function ProviderFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/providers" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Name contains</span>
        <input
          type="text"
          name="q"
          defaultValue={initial.q ?? ''}
          placeholder="Amara"
          maxLength={64}
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Status</span>
        <select name="status" defaultValue={initial.status ?? ''}>
          <option value="">Any</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Tier</span>
        <select name="tier" defaultValue={initial.tier ?? ''}>
          <option value="">Any</option>
          {TIER_OPTIONS.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Archived</span>
        <select name="includeArchived" defaultValue={initial.includeArchived ? 'true' : 'false'}>
          <option value="false">Hide archived</option>
          <option value="true">Include archived</option>
        </select>
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply filters
        </button>
        <Link href="/providers" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────

function ProviderTable({
  list,
  filters,
  canOpen360,
}: {
  readonly list: ProviderDirectoryListResponse;
  readonly filters: ListFilters;
  readonly canOpen360: boolean;
}): React.JSX.Element {
  if (list.providers.length === 0) {
    return (
      <div className="user-empty">
        <p>
          {list.total === 0
            ? 'No providers match these filters.'
            : 'No providers on this page — you have paged past the end of the results.'}
        </p>
      </div>
    );
  }

  const first = list.offset + 1;
  const last = list.offset + list.providers.length;

  return (
    <>
      <p className="user-detail__hint">
        Showing {first}–{last} of {list.total} matching{' '}
        {list.total === 1 ? 'provider' : 'providers'}.
      </p>

      {!canOpen360 && (
        <p className="user-detail__hint">
          Rows are not links for you: the Provider 360 also requires <code>trust_safety:write</code>
          , which your roles do not include.
        </p>
      )}

      <div className="user-table" role="table" aria-label="Providers">
        <div className="user-table__head" role="row">
          <span role="columnheader">Name</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Tier</span>
          <span role="columnheader">Time zone</span>
          <span role="columnheader">Since</span>
        </div>
        {list.providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} canOpen360={canOpen360} />
        ))}
      </div>

      <Pagination list={list} filters={filters} />
    </>
  );
}

function ProviderRow({
  provider,
  canOpen360,
}: {
  readonly provider: ProviderDirectoryRow;
  readonly canOpen360: boolean;
}): React.JSX.Element {
  const cells = (
    <>
      <span role="cell">
        <span className="user-row__email">{provider.displayName}</span>
        {provider.deletedAt !== null && (
          <span className="user-row__chip user-row__chip--warn">archived</span>
        )}
        {provider.dementiaSensitive && <span className="user-row__chip">dementia-sensitive</span>}
        {provider.headline !== null && (
          <span className="user-detail__hint"> {provider.headline}</span>
        )}
      </span>
      <span role="cell" className={`user-row__status user-row__status--${provider.status}`}>
        {provider.status.replace(/_/g, ' ')}
      </span>
      <span role="cell">{provider.tier}</span>
      <span role="cell">{provider.timeZone}</span>
      <span role="cell" className="user-row__date">
        {formatDate(provider.createdAt)}
      </span>
    </>
  );

  if (!canOpen360) {
    return (
      <div className="user-row" role="row">
        {cells}
      </div>
    );
  }

  return (
    <Link
      href={`/providers/${encodeURIComponent(provider.id)}/360`}
      className="user-row"
      role="row"
    >
      {cells}
    </Link>
  );
}

/**
 * Offset pagination. Both directions are rendered, because an operator
 * who paged forward past what they wanted needs a way back that is not
 * the browser's history stack — a back-button return re-issues the
 * previous query, which on a live directory can show a different page.
 */
function Pagination({
  list,
  filters,
}: {
  readonly list: ProviderDirectoryListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  const hasPrev = list.offset > 0;
  const hasNext = list.offset + list.providers.length < list.total;

  if (!hasPrev && !hasNext) {
    return <p className="user-pagination">End of list.</p>;
  }

  const prevOffset = Math.max(0, list.offset - list.limit);
  const nextOffset = list.offset + list.limit;

  return (
    <p className="user-pagination">
      {hasPrev && (
        <Link
          href={`/providers?${queryString(filters, prevOffset)}`}
          className="filter-bar__submit"
        >
          ← Previous
        </Link>
      )}{' '}
      {hasNext && (
        <Link
          href={`/providers?${queryString(filters, nextOffset)}`}
          className="filter-bar__submit"
        >
          Next page →
        </Link>
      )}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Data + params
// ─────────────────────────────────────────────────────────────────────

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchProviders(filters: ListFilters): Promise<ProviderDirectoryListResponse | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/providers?${queryString(filters, filters.offset)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ProviderDirectoryListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

/**
 * Serialise the filters for both the gateway call and the pagination
 * links. One function for both so a filter can never be applied to the
 * query but dropped from the "next page" href — the failure mode where
 * page 2 quietly shows an unfiltered roster.
 */
function queryString(filters: ListFilters, offset: number): string {
  const params = new URLSearchParams();
  if (filters.q !== null) params.set('q', filters.q);
  if (filters.status !== null) params.set('status', filters.status);
  if (filters.tier !== null) params.set('tier', filters.tier);
  if (filters.includeArchived) params.set('includeArchived', 'true');
  params.set('limit', String(PROVIDER_DIRECTORY_LIMIT_DEFAULT));
  if (offset > 0) params.set('offset', String(offset));
  return params.toString();
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 10);
}
