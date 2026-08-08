import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { getMyConcierge, type MyConciergeResult } from '@/lib/concierge-api';
import { getMyOnboarding, type MyOnboardingResult } from '@/lib/concierge-onboarding-api';

import { logoutAction } from './actions';

export const metadata: Metadata = {
  title: 'Your dashboard — Taste & See',
};

/**
 * Family dashboard placeholder (TS-121).
 *
 * The skeleton renders three things:
 *   - The signed-in user's id (from the gateway `/me` actor-identity
 *     readback — no PII, just confirmation the session works).
 *   - A welcome line explaining what's coming.
 *   - A logout form posting to the server action.
 *
 * Phase-2 milestones land as sibling files:
 *   - TS-124 — subscription detail / Stripe Checkout entry.
 *   - TS-125 — provider discovery + booking flow.
 *   - TS-230 — wellness summaries + family peace-of-mind cards.
 *
 * Senior-mode UI toggle (CLAUDE.md §8.3 / PDD §6.3) is a TS-121
 * follow-up — the design tokens already carry the AAA contrast pair;
 * the toggle wiring + persistence land alongside the household-setup
 * flow that captures the senior's preferences.
 */

const MeBodySchema = z.object({
  userId: z.string().min(1),
  mfaVerified: z.boolean(),
});

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  const parsed = MeBodySchema.safeParse(result.body);
  if (!parsed.success) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  // Tier-3 households have a dedicated concierge; the card only renders
  // when one is actively assigned (TS-222). A non-Tier-3 family sees no
  // card — the read failing-soft to `unavailable`/`none` simply omits it.
  // The onboarding card (TS-228) renders only while a white-glove kickoff
  // is in progress; both reads fail soft.
  const [concierge, onboarding] = await Promise.all([getMyConcierge(), getMyOnboarding()]);

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <div className="dash-account">
          <span title={parsed.data.userId}>Signed in</span>
          <form action={logoutAction}>
            <button type="submit" className="dash-logout">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="dash-main">
        <h1>Your table is set.</h1>
        <p>
          We&apos;re building your family&apos;s home base — billing, visits, the people who cook
          and keep company with your loved one. The next few sections will appear here as the
          experience opens up over the coming weeks.
        </p>
        <YourConciergeCard concierge={concierge} />
        <YourOnboardingCard onboarding={onboarding} />
        <div className="dash-cards">
          <article className="dash-card">
            <h2>Choose a chef</h2>
            <p>
              Browse our vetted roster of chefs and culinary companions, then ask our concierge team
              to confirm a fit.{' '}
              <Link href="/providers" className="link-inline">
                Browse providers
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Your visits</h2>
            <p>
              See upcoming and past visits, with notes from each one.{' '}
              <Link href="/bookings" className="link-inline">
                See your visits
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Your loved ones</h2>
            <p>
              Tell us about the people we cook for — favourite dishes, traditions, and the cues that
              make a visit feel like home.{' '}
              <Link href="/seniors" className="link-inline">
                Edit their preferences
              </Link>
              .
            </p>
          </article>
          {/*
            Two links, because these are two different moments and the
            second had no way in at all. `/billing` shipped with
            TS-042-followup-3a3-followup-1 reachable ONLY from a dunning
            email — so the one page where a family can fix a failed
            payment was, in effect, hidden from anyone not already in
            trouble. `/plans` is for choosing; `/billing` is for the plan
            you already have.
          */}
          <article className="dash-card">
            <h2>Your plan &amp; billing</h2>
            <p>
              See the plan you&apos;re on, update the card we charge, and find every receipt.{' '}
              <Link href="/billing" className="link-inline">
                Your billing
              </Link>
              . Not signed up yet?{' '}
              <Link href="/plans" className="link-inline">
                See plans
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Make a request</h2>
            <p>
              A holiday dinner, a birthday, a museum afternoon, or anything else — tell us and
              we&apos;ll arrange it.{' '}
              <Link href="/concierge/requests" className="link-inline">
                Make a request
              </Link>
              .
            </p>
          </article>
          <article className="dash-card dash-card--urgent">
            <h2>Need help now?</h2>
            <p>
              If something urgent comes up, reach our on-call concierge team right away.{' '}
              <Link href="/concierge/emergency" className="link-inline">
                Emergency assistance
              </Link>
              . Something worrying you that can wait a little?{' '}
              <Link href="/report-concern" className="link-inline">
                Report a concern
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Your privacy</h2>
            <p>
              Your information — and your loved one&apos;s — is yours. Ask for a copy of what we
              hold, or ask us to remove it.{' '}
              <Link href="/privacy" className="link-inline">
                Your privacy
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Visits &amp; wellness</h2>
            <p>
              Upcoming visits at a glance, plus warm notes from every visit so far — appetite,
              spirits, the rhythm of the day.{' '}
              <Link href="/dashboard/visits" className="link-inline">
                See visits &amp; wellness
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Weekly recaps</h2>
            <p>
              Each week your concierge shares a warm recap of visits, wellbeing, and the company
              your loved one has kept.{' '}
              <Link href="/concierge/enrichment" className="link-inline">
                Read your recaps
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Saved searches</h2>
            <p>
              Name a chef search you keep coming back to and rerun it any time.{' '}
              <Link href="/saved-searches" className="link-inline">
                See your saved searches
              </Link>
              .
            </p>
          </article>
          <article className="dash-card">
            <h2>Favourite chefs</h2>
            <p>
              The chefs you&apos;ve loved before, ready to revisit.{' '}
              <Link href="/favorites" className="link-inline">
                See your favourites
              </Link>
              .
            </p>
          </article>
        </div>
      </main>
    </div>
  );
}

/**
 * "Your concierge" card (TS-222). Renders only when the household has an
 * active dedicated concierge — a Tier-3 perk (PRD §5.1). Hidden for
 * non-Tier-3 households (`none`) and when the read fails soft
 * (`unavailable`) so a downstream blip never breaks the dashboard.
 */
function YourConciergeCard({
  concierge,
}: {
  readonly concierge: MyConciergeResult;
}): React.JSX.Element | null {
  if (concierge.kind !== 'assigned') return null;
  const { assignment } = concierge;
  return (
    <section className="dash-concierge" aria-label="Your dedicated concierge">
      <h2>Your concierge</h2>
      <p>
        <strong>{assignment.primaryConciergeDisplayName}</strong> is your family&apos;s dedicated
        culinary concierge — your single point of contact for chef visits, outings, and special
        requests.
      </p>
      {assignment.backupConciergeDisplayName !== null && (
        <p className="dash-concierge__backup">
          When {assignment.primaryConciergeDisplayName.split(' ')[0]} is away,{' '}
          <strong>{assignment.backupConciergeDisplayName}</strong> steps in.
        </p>
      )}
    </section>
  );
}

/**
 * "Getting started" card (TS-228). Renders the read-only white-glove kickoff
 * progress while an onboarding is in flight. Hidden once it's completed or
 * canceled, and when the household has none / the read fails soft.
 */
function YourOnboardingCard({
  onboarding,
}: {
  readonly onboarding: MyOnboardingResult;
}): React.JSX.Element | null {
  if (onboarding.kind !== 'onboarding') return null;
  const record = onboarding.onboarding;
  if (record.status === 'completed' || record.status === 'canceled') return null;
  const pct =
    record.stepsTotal === 0 ? 0 : Math.round((record.stepsCompleted / record.stepsTotal) * 100);
  return (
    <section className="dash-concierge" aria-label="Your onboarding progress">
      <h2>Getting started</h2>
      <p>
        Your concierge team is setting everything up for a warm welcome — {record.stepsCompleted} of{' '}
        {record.stepsTotal} kickoff steps are done.
      </p>
      <div className="dash-onboarding__track" aria-hidden="true">
        <div className="dash-onboarding__fill" style={{ width: `${pct}%` }} />
      </div>
      <p>
        <Link href="/concierge/onboarding" className="link-inline">
          See your onboarding progress
        </Link>
        .
      </p>
    </section>
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
      <form action={logoutAction}>
        <button type="submit" className="dash-logout">
          Sign out
        </button>
      </form>
    </main>
  );
}
