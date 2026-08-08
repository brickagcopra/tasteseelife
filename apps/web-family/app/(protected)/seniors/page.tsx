import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { listMySeniors } from '@/lib/seniors-api';

export const metadata: Metadata = {
  title: 'Your loved ones — Taste & See',
};

/**
 * "Your loved ones" directory (TS-214).
 *
 * Lists every active senior in a household the signed-in family member
 * belongs to (resolved by the gateway `GET /api/v1/me/seniors` proxy →
 * service-household). Each row links to the senior's preference editor —
 * the warmth-and-memory profile a chef reads before a visit.
 *
 * This is the family-portal entry point into the per-senior surfaces.
 * Each card's name links to the per-senior hub (`/seniors/[seniorId]`,
 * TS-237) which fans out to the leaf surfaces (preferences, wellness,
 * photos, sharing, alerts, recommended chefs) — so a household with more
 * than one aging parent keeps each loved one's home distinct, and the
 * directory card stays a clean roster rather than a growing link-list.
 */
export default async function SeniorsPage(): Promise<React.JSX.Element> {
  const result = await listMySeniors();
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
        <h1>Your loved ones</h1>
        <p>
          Tell us about the people we cook for — favourite dishes, the traditions that feel like
          home, and the gentle cues that make a visit easy. The more we know, the more every meal
          feels like theirs.
        </p>

        {result.kind !== 'ok' ? (
          <p className="providers-empty">
            We couldn&apos;t load your loved ones right now. Please refresh in a moment.
          </p>
        ) : result.seniors.length === 0 ? (
          <div className="providers-empty">
            <p>
              We don&apos;t have anyone on file for your household yet. Once your household setup is
              complete, the people you care for will appear here.
            </p>
          </div>
        ) : (
          <ul className="seniors-list">
            {result.seniors.map((senior) => {
              const name =
                senior.displayName !== null && senior.displayName.length > 0
                  ? senior.displayName
                  : senior.firstName;
              const hubHref = `/seniors/${encodeURIComponent(senior.seniorId)}`;
              return (
                <li key={senior.seniorId} className="seniors-card">
                  <div className="seniors-card__head">
                    <Link href={hubHref} className="seniors-card__name-link">
                      {name} {senior.lastName}
                    </Link>
                    {senior.status !== 'active' ? (
                      <span className="seniors-card__status" data-status={senior.status}>
                        {senior.status === 'paused' ? 'Paused' : 'Archived'}
                      </span>
                    ) : null}
                  </div>
                  <div className="seniors-card__actions">
                    <Link href={hubHref} className="link-inline">
                      Open {name}&apos;s profile
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
