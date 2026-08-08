import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  FeaturedPlacementsListResponseSchema,
  FEATURED_PLACEMENT_BOOST_DEFAULT,
  FEATURED_PLACEMENT_BOOST_MAX,
  FEATURED_PLACEMENT_BOOST_MIN,
  FEATURED_PLACEMENT_NOTE_MAX_LENGTH,
  FEATURED_PLACEMENT_REGION_CODE_MAX_LENGTH,
  MeResponseSchema,
  type FeaturedPlacementRecord,
  type FeaturedPlacementsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import { cancelFeaturedPlacementAction, scheduleFeaturedPlacementAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Featured placements — Taste & See Admin',
};

/**
 * Admin featured-placements browser (TS-207; PRD §7.2, §10.5; PDD §14.1).
 *
 * Lists the scheduled featured windows service-search's ranking layer
 * applies as a per-provider score boost during the window, and offers a
 * form to schedule a new one + a per-row cancel affordance. Enforces the
 * same three gates every admin surface does: authenticated, MFA-verified,
 * active super_admin role.
 */
export default async function FeaturedPlacementsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
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
  if (!hasSuperAdminRole(me)) redirect('/dashboard/no-access');

  const list = await fetchFeaturedPlacements();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — featured placements</span>
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
        <h1>Featured placements</h1>
        <p>
          Schedule a window during which a provider gets a ranking boost in family-portal search
          results (PRD §7.2, §10.5). The boost is applied at query time by service-search&apos;s
          ranking layer and surfaces as a &ldquo;Featured&rdquo; badge on the provider card.
        </p>
        <p className="user-detail__hint">
          Boost is a score multiplier between {FEATURED_PLACEMENT_BOOST_MIN} and{' '}
          {FEATURED_PLACEMENT_BOOST_MAX} (default {FEATURED_PLACEMENT_BOOST_DEFAULT}). Leave the
          region or tier blank to feature the provider everywhere / for every tier. Phase-1 search
          applies region-blank placements only — per-region matching lands with region resolution.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Scheduled placements</h2>
          {list === null ? (
            <p className="auth-alert">
              We couldn&apos;t load the featured-placements table right now. The downstream search
              service may be unreachable.
            </p>
          ) : (
            <FeaturedPlacementsList list={list} />
          )}
        </section>

        <ScheduleForm />
      </main>
    </div>
  );
}

function FeaturedPlacementsList({
  list,
}: {
  readonly list: FeaturedPlacementsListResponse;
}): React.JSX.Element {
  if (list.placements.length === 0) {
    return (
      <div className="user-empty">
        <p>No featured placements scheduled yet. Use the form below to add one.</p>
      </div>
    );
  }
  const now = Date.now();
  return (
    <div className="user-detail__actions-grid">
      {list.placements.map((placement) => (
        <FeaturedPlacementCard key={placement.id} placement={placement} now={now} />
      ))}
    </div>
  );
}

type WindowStatus = 'active' | 'scheduled' | 'expired';

function windowStatus(placement: FeaturedPlacementRecord, now: number): WindowStatus {
  const startsAt = Date.parse(placement.startsAt);
  const endsAt = Date.parse(placement.endsAt);
  if (now >= endsAt) return 'expired';
  if (now < startsAt) return 'scheduled';
  return 'active';
}

const STATUS_CHIP: Record<WindowStatus, string> = {
  active: 'user-row__chip user-row__chip--ok',
  scheduled: 'user-row__chip',
  expired: 'user-row__chip user-row__chip--warn',
};

function FeaturedPlacementCard({
  placement,
  now,
}: {
  readonly placement: FeaturedPlacementRecord;
  readonly now: number;
}): React.JSX.Element {
  const status = windowStatus(placement, now);
  const cancelBound = cancelFeaturedPlacementAction.bind(null, placement.id);

  return (
    <div className="user-detail__action-card">
      <h3 className="user-detail__role-name">
        <code>{placement.providerId}</code> <span className={STATUS_CHIP[status]}>{status}</span>
      </h3>
      <p className="user-detail__hint">
        ×{placement.boostMultiplier} boost · {placement.regionCode ?? 'all regions'} ·{' '}
        {placement.tier ?? 'all tiers'}
      </p>
      <p className="user-detail__hint">
        {formatDate(placement.startsAt)} → {formatDate(placement.endsAt)}
      </p>
      {placement.note !== null && <p className="user-detail__hint">“{placement.note}”</p>}
      {placement.createdByUserId !== null && (
        <p className="user-detail__hint">
          Scheduled by <code>{placement.createdByUserId}</code>
        </p>
      )}
      <form action={cancelBound} className="user-detail__action-form">
        <button
          type="submit"
          className="user-detail__action-button user-detail__action-button--danger"
        >
          Cancel placement
        </button>
      </form>
    </div>
  );
}

function ScheduleForm(): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Schedule a placement</h2>
      <form action={scheduleFeaturedPlacementAction} className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Provider id</span>
          <input type="text" name="providerId" required placeholder="prov_…" autoComplete="off" />
        </label>
        <label className="user-detail__action-label">
          <span>Region code (optional — blank = all regions)</span>
          <input
            type="text"
            name="regionCode"
            maxLength={FEATURED_PLACEMENT_REGION_CODE_MAX_LENGTH}
            pattern="[a-z0-9][a-z0-9_-]*"
            placeholder="nyc"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Tier (optional — blank = all tiers)</span>
          <select name="tier" defaultValue="">
            <option value="">All tiers</option>
            <option value="basic">Basic</option>
            <option value="certified">Certified</option>
            <option value="elite">Elite</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Boost multiplier</span>
          <input
            type="number"
            name="boostMultiplier"
            defaultValue={FEATURED_PLACEMENT_BOOST_DEFAULT}
            step="0.1"
            min={FEATURED_PLACEMENT_BOOST_MIN}
            max={FEATURED_PLACEMENT_BOOST_MAX}
            required
          />
        </label>
        <label className="user-detail__action-label">
          <span>Starts at</span>
          <input type="datetime-local" name="startsAt" required />
        </label>
        <label className="user-detail__action-label">
          <span>Ends at</span>
          <input type="datetime-local" name="endsAt" required />
        </label>
        <label className="user-detail__action-label">
          <span>Note (optional)</span>
          <input
            type="text"
            name="note"
            maxLength={FEATURED_PLACEMENT_NOTE_MAX_LENGTH}
            placeholder="Why this provider is featured"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          Schedule placement
        </button>
      </form>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Featured placements updated.
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
    case 'provider-required':
      return 'A provider id is required.';
    case 'region-invalid':
      return 'Region code must be lower-case alphanumeric with _ or - (and start with a letter or digit).';
    case 'tier-invalid':
      return 'Tier must be basic, certified, or elite.';
    case 'boost-invalid':
      return `Boost must be a number between ${FEATURED_PLACEMENT_BOOST_MIN} and ${FEATURED_PLACEMENT_BOOST_MAX}.`;
    case 'dates-required':
      return 'Both a start and end time are required.';
    case 'window-invalid':
      return 'The end time must be strictly after the start time.';
    case 'note-too-long':
      return `Note must be at most ${FEATURED_PLACEMENT_NOTE_MAX_LENGTH} characters.`;
    case 'not-found':
      return "We couldn't find that placement — it may have already been cancelled.";
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The search service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
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

async function fetchFeaturedPlacements(): Promise<FeaturedPlacementsListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/search/featured-placements');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = FeaturedPlacementsListResponseSchema.safeParse(result.body);
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
