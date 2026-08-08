import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { MySeniorSummary } from '@taste-and-see/contracts';

import { listMySeniors } from '@/lib/seniors-api';

export const metadata: Metadata = {
  title: 'Your loved one — Taste & See',
};

/**
 * Per-senior hub / detail page (TS-237).
 *
 * The `/seniors` directory lists every senior in the signed-in member's
 * household; this is the home for ONE of them. A household can hold more
 * than one aging parent (service-household has supported the N-to-1
 * relationship since TS-030), so the family portal needs a per-senior
 * surface — not a single conflated dashboard — to keep each loved one's
 * preferences, wellness, photos, and sharing choices distinct.
 *
 * Navigation hub (the scope confirmed with the user): a name + status
 * header and a card fan-out to the existing per-senior leaf surfaces
 * (preferences, recommended chefs, wellness trends, photos, sharing,
 * alerts). No new cross-service reads — the senior summary comes from the
 * same `GET /api/v1/me/seniors` directory read the index uses, so this
 * page adds zero backend surface. A richer per-senior overview (inline
 * upcoming visits + a wellness snapshot) is carved as TS-237-followup-1.
 *
 * Reachability: `listMySeniors` is the household-membership gate. A
 * seniorId that isn't in one of the caller's households simply isn't in
 * the list, so it renders the friendly "couldn't find that loved one"
 * panel — a foreign id can't be probed (mirrors the TS-238 sharing page).
 */

interface SurfaceCard {
  /** Path suffix appended under `/seniors/{id}/`. */
  readonly path: string;
  readonly title: string;
  readonly copy: string;
  readonly cta: string;
}

const SURFACES: readonly SurfaceCard[] = [
  {
    path: 'preferences',
    title: 'Preferences & memories',
    copy: 'Favourite dishes, the traditions that feel like home, and the gentle cues that make a visit easy.',
    cta: 'Edit preferences',
  },
  {
    path: 'recommendations',
    title: 'Recommended chefs',
    copy: 'Chefs and culinary companions matched to their tastes, dietary needs, and the company they enjoy.',
    cta: 'See recommended chefs',
  },
  {
    path: 'wellness',
    title: 'Wellness trends',
    copy: 'How spirits, appetite, and connection have trended across recent visits — at a glance.',
    cta: 'See wellness trends',
  },
  {
    path: 'photos',
    title: 'Photos',
    copy: 'Moments shared from recent visits, so family can see the days they missed.',
    cta: 'See photos',
  },
  {
    path: 'sharing',
    title: 'Sharing settings',
    copy: 'Choose which moments and details family members who follow along can see. Private by default.',
    cta: 'Manage sharing',
  },
  {
    path: 'alerts',
    title: 'Alert settings',
    copy: 'Pick which updates reach you — a missed visit, a concern worth knowing, or an urgent flag.',
    cta: 'Manage alerts',
  },
];

function resolveName(senior: MySeniorSummary): string {
  return senior.displayName !== null && senior.displayName.length > 0
    ? senior.displayName
    : senior.firstName;
}

export default async function SeniorHubPage({
  params,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;
  const result = await listMySeniors();

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (result.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load this profile right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const senior = result.seniors.find((s) => s.seniorId === seniorId);
  if (senior === undefined) {
    return (
      <Shell>
        <h1>We couldn&apos;t find that loved one</h1>
        <p className="providers-empty">
          This profile isn&apos;t in your household, or it may have been removed.{' '}
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
          .
        </p>
      </Shell>
    );
  }

  const name = resolveName(senior);

  return (
    <Shell>
      <div className="senior-hub__head">
        <h1>
          {name} {senior.lastName}
        </h1>
        {senior.status !== 'active' ? (
          <span className="seniors-card__status" data-status={senior.status}>
            {senior.status === 'paused' ? 'Paused' : 'Archived'}
          </span>
        ) : null}
      </div>
      <p>
        Everything for {name} in one place — the warmth-and-memory profile a chef reads before a
        visit, how recent visits have gone, and what you and the rest of the family can see.
      </p>

      <div className="dash-cards">
        {SURFACES.map((surface) => (
          <article key={surface.path} className="dash-card">
            <h2>{surface.title}</h2>
            <p>
              {surface.copy}{' '}
              <Link
                href={`/seniors/${encodeURIComponent(seniorId)}/${surface.path}`}
                className="link-inline"
              >
                {surface.cta}
              </Link>
              .
            </p>
          </article>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/seniors" className="dash-logout">
          Your loved ones
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
