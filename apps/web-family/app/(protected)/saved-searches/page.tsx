import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { listSavedSearches } from '@/lib/saved-searches-api';

import { deleteSavedSearchAction, runSavedSearchAction } from './actions';

export const metadata: Metadata = {
  title: 'Saved searches — Taste & See',
};

/**
 * Saved-searches list page (TS-215).
 *
 * Renders every saved search the actor has created, newest-used first.
 * Per-row actions:
 *   - **Run**: bump `lastRunAt` and redirect to `/providers?savedSearchId=…`
 *     so the family can see the live result grid.
 *   - **Delete**: idempotent — disappears from the list on success.
 *
 * The "Save a search" entry point lives on `/providers` (heart icon on
 * the search bar — TS-215-followup-1 wires it). Today this list is
 * reachable from the dashboard once a row exists; ops can also use the
 * direct gateway endpoint via curl to seed a row for QA.
 */
export default async function SavedSearchesPage(): Promise<React.JSX.Element> {
  const result = await listSavedSearches();
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your saved searches</h1>
        <p>
          Name a chef search you keep coming back to — &ldquo;Italian-speaking chefs near
          Mom&rdquo;, say — and rerun it any time without rebuilding the filters.
        </p>

        {result.kind !== 'ok' ? (
          <p className="providers-empty">
            We couldn&apos;t load your saved searches right now. Please refresh in a moment.
          </p>
        ) : result.savedSearches.length === 0 ? (
          <div className="providers-empty">
            <p>
              You haven&apos;t saved a search yet. Browse the{' '}
              <Link href="/providers" className="link-inline">
                chef directory
              </Link>{' '}
              and save a search you like.
            </p>
          </div>
        ) : (
          <ul className="saved-searches-list">
            {result.savedSearches.map((row) => (
              <li key={row.id} className="saved-searches-row">
                <div className="saved-searches-row-head">
                  <h2>{row.name}</h2>
                  <span className="saved-searches-meta">
                    {row.lastRunAt !== null
                      ? `Last run ${formatRelative(row.lastRunAt)}`
                      : 'Never run yet'}
                  </span>
                </div>
                <SavedSearchQuerySummary query={row.query} />
                <div className="saved-searches-row-actions">
                  <form action={runSavedSearchAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className="plans-cta">
                      Run search
                    </button>
                  </form>
                  <form action={deleteSavedSearchAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className="dash-logout">
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

/**
 * Render a one-line summary of the stored `SearchProvidersRequest`
 * body — enough for the family to recognise what each saved search
 * actually searches for, without rendering every nested filter.
 */
function SavedSearchQuerySummary({
  query,
}: {
  readonly query: {
    readonly query?: string | undefined;
    readonly filters?: { readonly tiers?: readonly string[] | undefined } | undefined;
  };
}): React.JSX.Element {
  const parts: string[] = [];
  if (typeof query.query === 'string' && query.query.length > 0) {
    parts.push(`"${query.query}"`);
  }
  if (query.filters?.tiers !== undefined && query.filters.tiers.length > 0) {
    parts.push(`tier: ${query.filters.tiers.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push('all chefs');
  }
  return <p className="saved-searches-summary">{parts.join(' · ')}</p>;
}

/**
 * Format an ISO timestamp as a coarse relative-time string. Bare —
 * Intl.RelativeTimeFormat lands as a follow-up; "a few hours ago" is
 * enough signal here.
 */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const diffMs = Date.now() - then;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
