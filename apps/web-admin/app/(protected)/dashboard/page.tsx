import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasAnyAdminRole, hasSuperAdminRole } from '@/lib/admin-gate';

import { logoutAction } from './actions';

export const metadata: Metadata = {
  title: 'Console — Taste & See Admin',
};

/**
 * Admin-console dashboard placeholder (TS-123).
 *
 * Render order:
 *   1. `/api/v1/me` round-trip to materialise the actor's
 *      RequestContext (roles, scope, mfaVerified).
 *   2. If `mfaVerified` is false: bounce to `/login?expired=1` (the
 *      MFA-verify hop should have flipped this true; finding it false
 *      means the access token was minted on a non-MFA path which is
 *      illegal for any admin actor).
 *   3. If no admin role: bounce to `/login?no_admin_role=1`.
 *   4. If has admin role but not super_admin: redirect to
 *      `/dashboard/no-access` (Phase-1 only super_admins land on the
 *      root surface — TS-126 / TS-290 grow per-permission surfaces
 *      for other admin roles).
 *   5. Render the three placeholder cards (Users / Subscriptions /
 *      Audit log).
 */
export default async function DashboardPage(): Promise<React.JSX.Element> {
  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  if (!me.mfaVerified) {
    redirect('/login?expired=1');
  }

  if (!hasAnyAdminRole(me)) {
    redirect('/login?no_admin_role=1');
  }

  if (!hasSuperAdminRole(me)) {
    redirect('/dashboard/no-access');
  }

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — operating in {scopeLabel(me)}</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <span>super_admin</span>
          <form action={logoutAction}>
            <button type="submit" className="dash-logout">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="dash-main">
        <h1>Operations console</h1>
        <p>
          The control plane for Taste &amp; See. Use it carefully — every action you take here is
          recorded in the immutable audit log. The surfaces below light up as their implementation
          lands.
        </p>
        <div className="dash-cards">
          <article className="dash-card">
            <h2>Users</h2>
            <p>
              Search families, seniors, providers, partners, and staff. Review KYC and role
              assignments. Read-only at launch — mutations land in later slices.
            </p>
            <Link href="/users" className="dash-card__cta">
              Open users console →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Roles &amp; permissions</h2>
            <p>
              Build custom roles with the visual permission matrix, and review the seeded system
              roles. Gated on <code>rbac:read</code> / <code>rbac:write</code>.
            </p>
            <Link href="/roles" className="dash-card__cta">
              Open role builder →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Subscriptions</h2>
            <p>
              Browse subscriptions across every customer group with plan, status, and dunning state
              at a glance. Read-only at launch — comp, refund, and pause mutations land in later
              slices.
            </p>
            <Link href="/subscriptions" className="dash-card__cta">
              Open subscriptions console →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Bookings</h2>
            <p>
              Browse bookings across every household, senior, and provider with status, schedule,
              and price at a glance. Read-only at launch — manual booking creation, cancellation,
              refund, and dispute resolution land in later slices.
            </p>
            <Link href="/bookings" className="dash-card__cta">
              Open bookings console →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Accounting</h2>
            <p>
              Browse the double-entry journal ledger, inspect per-account balances on the trial
              balance, and audit period close / reopen lifecycle events. Read-only at launch —
              mutations land in later slices.
            </p>
            <Link href="/accounting" className="dash-card__cta">
              Open accounting console →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Search ranking</h2>
            <p>
              Tune the per-region tier-weight multipliers that service-search applies to provider
              results. The global row is the load-bearing fallback; per-region rows override it for
              actors whose query resolves to a known region.
            </p>
            <Link href="/search/ranking-config" className="dash-card__cta">
              Open search ranking →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Search relevance</h2>
            <p>
              Track search quality — top queries, how often searches come back empty, CTR by result
              position, and how searches convert to bookings — computed nightly from raw query,
              click, and booking events. Feeds ranking tuning.
            </p>
            <Link href="/search/metrics" className="dash-card__cta">
              Open search relevance →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Featured placements</h2>
            <p>
              Schedule windows during which a provider gets a search ranking boost + a
              &ldquo;Featured&rdquo; badge in family-portal results. Scope by region or tier, set
              the boost multiplier, and cancel a placement at any time.
            </p>
            <Link href="/search/featured-placements" className="dash-card__cta">
              Open featured placements →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Concierge assignments</h2>
            <p>
              Assign a dedicated culinary concierge to a Tier&nbsp;3 household — a primary plus an
              optional backup. Look up a household to see its current concierge + history, reassign,
              or end an assignment.
            </p>
            <Link href="/concierge/assignments" className="dash-card__cta">
              Open concierge assignments →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Concierge ops queue</h2>
            <p>
              Work the concierge ticket queue, soonest SLA first: add internal notes, transition a
              ticket through its lifecycle, and escalate to the lead, ops, or Trust &amp; Safety.
              Gated on <code>concierge:read</code> / <code>concierge:write</code>.
            </p>
            <Link href="/concierge/tickets" className="dash-card__cta">
              Open concierge ops queue →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Concierge scheduled events</h2>
            <p>
              Book the experiences that fulfil Tier&nbsp;3 requests — restaurant reservations,
              cultural events, and group outings — track their status, and record confirmations.
              Gated on <code>concierge:read</code> / <code>concierge:write</code>.
            </p>
            <Link href="/concierge/scheduled-events" className="dash-card__cta">
              Open scheduled events →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Concierge transportation</h2>
            <p>
              Arrange and track Tier&nbsp;3 rides — medical appointments, outings, social visits —
              cancel or reschedule, and watch vendor driver state mirror back. Gated on{' '}
              <code>concierge:read</code> / <code>concierge:write</code>.
            </p>
            <Link href="/concierge/transportation" className="dash-card__cta">
              Open transportation →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Tier 3 onboarding</h2>
            <p>
              Run the white-glove kickoff checklist for a new Tier&nbsp;3 household — the kickoff
              call, senior-preference deep-dive, family expectation-setting, and first-week steps.
              Gated on <code>concierge:read</code> / <code>concierge:write</code>.
            </p>
            <Link href="/concierge/onboarding" className="dash-card__cta">
              Open Tier 3 onboarding →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Tier 3 enrichment summaries</h2>
            <p>
              Write the weekly white-glove recap for a Tier&nbsp;3 household — visit highlights,
              wellness signals, social engagement. Publish to surface it on the family dashboard.
              Gated on <code>concierge:read</code> / <code>concierge:write</code>.
            </p>
            <Link href="/concierge/enrichment-summaries" className="dash-card__cta">
              Open enrichment summaries →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Trust &amp; safety incidents</h2>
            <p>
              The concern queue across families, seniors, providers, and concierges — soonest SLA
              first, with the incidents already in the statutory pathway flagged. The queue is gated
              on <code>trust_safety:read</code>; reading a report needs{' '}
              <code>trust_safety:write</code>.
            </p>
            <Link href="/trust-safety/incidents" className="dash-card__cta">
              Open incident queue →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Booking holds</h2>
            <p>
              Visits suspended because an incident named the provider, the senior, or the household
              — what is on hold, since when, by which incident, and how many visits that is
              interrupting. Read-only: a hold is lifted by resolving the incident that placed it.
              Gated on <code>trust_safety:read</code>.
            </p>
            <Link href="/trust-safety/holds" className="dash-card__cta">
              Open booking holds →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Mandated-reporter cases</h2>
            <p>
              Work the statutory pathway for suspected abuse or neglect — reportability
              determination, filing prep against a compliance-verified state kit, the filing itself,
              and the second-operator signoff that releases the incident. Gated on{' '}
              <code>trust_safety:write</code>.
            </p>
            <Link href="/trust-safety/mandated-reporter" className="dash-card__cta">
              Open mandated-reporter cases →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Jurisdiction kit</h2>
            <p>
              Maintain the per-state mandated-reporter workflow kit — receiving agency, hotline,
              portal, statutory window, and reporting duty — and attest that each row matches its
              counsel-reviewed source. An unattested state blocks filing preparation. Gated on{' '}
              <code>trust_safety:write</code>.
            </p>
            <Link href="/trust-safety/mandated-reporter/jurisdictions" className="dash-card__cta">
              Open jurisdiction kit →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Providers</h2>
            <p>
              Search the provider roster by name, status, and tier, and open a provider&apos;s 360 —
              credentials, tier history, background-check verdict, and complaint history — for a
              review committee or a routine tier check. Archived providers are hidden until you ask
              for them. Gated on <code>provider:read</code>; the 360 itself also needs{' '}
              <code>trust_safety:write</code>.
            </p>
            <Link href="/providers" className="dash-card__cta">
              Open provider directory →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Cooking Academy</h2>
            <p>
              Author and curate the Academy curriculum — create courses, build their module &rarr;
              lesson tree, and schedule cohorts. Courses move draft &rarr; published &rarr;
              archived. Gated on <code>academy:read</code> / <code>academy:write</code>.
            </p>
            <Link href="/academy/courses" className="dash-card__cta">
              Open course catalog →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Ads campaigns</h2>
            <p>
              Create and manage in-app ad campaigns — sponsored provider listings, banners, and
              partner co-marketing slots. Set budgets, windows, and targeting; drive campaigns and
              creatives through their lifecycle. Gated on <code>ads:read</code> /{' '}
              <code>ads:write</code>.
            </p>
            <Link href="/ads/campaigns" className="dash-card__cta">
              Open ads campaigns →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Content &amp; blog</h2>
            <p>
              Author blog posts and help-center articles — dual-mode rich-text / Markdown,
              versioned, with draft &rarr; publish. Each version keeps its effective date for a full
              history. Gated on <code>content:read</code> / <code>content:edit</code> /{' '}
              <code>content:publish</code>.
            </p>
            <Link href="/content/articles" className="dash-card__cta">
              Open content →
            </Link>
            <Link href="/content/authors" className="dash-card__cta">
              Manage authors →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Ads slot inventory</h2>
            <p>
              Schedule which campaign occupies each predefined UI slot, and over what window —
              binding a campaign into a placement, ordered by priority where schedules overlap. Edit
              the window, priority, and lifecycle status. Gated on <code>ads:read</code> /{' '}
              <code>ads:write</code>.
            </p>
            <Link href="/ads/slots" className="dash-card__cta">
              Open slot inventory →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Ads creative review</h2>
            <p>
              Review partner- and provider-submitted creatives before they go live — each with an
              accessibility report (alt text, WCAG contrast, reduced-motion, the mandatory
              &ldquo;Sponsored&rdquo; disclosure). Approve, reject, or request changes; approving a
              failing report is an audited override. Gated on{' '}
              <code>marketing:approve_creative</code>.
            </p>
            <Link href="/ads/creatives" className="dash-card__cta">
              Open creative review →
            </Link>
          </article>
          <article className="dash-card dash-card--placeholder">
            <h2>Audit log</h2>
            <p>
              Append-only history of every staff action. Searchable by actor, action, resource, and
              time range. Tamper-evident via hash chaining. Available read-only at launch.
            </p>
          </article>
        </div>
      </main>
    </div>
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

function scopeLabel(me: MeResponse): string {
  switch (me.tenantScope.type) {
    case 'global':
      return 'global scope';
    case 'tenant':
      return `tenant ${me.tenantScope.tenantId}`;
    case 'household':
      return `household ${me.tenantScope.householdId}`;
  }
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>
        Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
        our team is already on it.
      </p>
      <form action={logoutAction}>
        <button type="submit" className="dash-logout">
          Sign out
        </button>
      </form>
    </main>
  );
}
