import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';

import { logoutAction } from './actions';

export const metadata: Metadata = {
  title: 'Your dashboard — Taste & See Provider Portal',
};

/**
 * Provider dashboard placeholder (TS-122).
 *
 * Mirrors `apps/web-family/app/(protected)/dashboard/page.tsx`. The
 * skeleton renders:
 *   - The signed-in user's id (from the gateway `/me` actor-identity
 *     readback — no PII, just confirmation the session works).
 *   - A welcome line.
 *   - Three placeholder cards — Profile, Calendar, Earnings & Payouts —
 *     covering the surfaces the provider portal will grow over Phase 1.
 *   - A logout form posting to the server action.
 *
 * Phase-1 milestones land as sibling files:
 *   - TS-051 — provider application + background-check wizard.
 *   - TS-053 — provider profile editor (bio, specialties, photo).
 *   - TS-061 — provider calendar / availability + booking inbox.
 *   - TS-080 — provider earnings + payout statements.
 *
 * Provider tier gating (PRD §5.4 / CLAUDE.md §12) is enforced at the
 * booking-svc layer when a Tier-3 family attempts to book — the portal
 * surfaces every active booking the provider has, without filtering on
 * tier here.
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

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Providers</span>
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
        <h1>Your kitchen, your calendar.</h1>
        <p>
          We&apos;re building the home base for your provider work — your application, calendar,
          profile, earnings, and the credential pathway. The next sections will appear here as the
          experience opens up over the coming weeks.
        </p>
        <div className="dash-cards">
          <article className="dash-card">
            <h2>Your profile</h2>
            <p>
              Tell families about your cooking, your training, and the kinds of meals you love to
              share. Edit your bio, languages, cuisines, and dietary specialties.
            </p>
            <p>
              <a href="/dashboard/profile">Edit your profile →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Your calendar</h2>
            <p>
              Set the days and hours you&apos;re available. Declare recurring weekly windows plus
              one-off blackout dates for trips and personal events.
            </p>
            <p>
              <a href="/dashboard/availability">Edit your schedule →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Where you cook</h2>
            <p>
              Draw the neighbourhoods you travel to. Coverage areas power search, so families nearby
              find you first.
            </p>
            <p>
              <a href="/dashboard/service-areas">Edit your coverage →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Raise a concern</h2>
            <p>
              Saw something on a visit that worried you — a client who seemed unwell or frightened,
              or conduct that shouldn&apos;t pass? Tell our trust &amp; safety team. Reporting never
              counts against you.
            </p>
            <p>
              <a href="/report-concern">Report a concern →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Your privacy</h2>
            <p>
              Ask us for a copy of the information we hold about your account, or ask us to remove
              it. We&apos;ll always answer, and we&apos;ll be straight about what we have to keep.
            </p>
            <p>
              <a href="/privacy">Your privacy →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Your rate</h2>
            <p>
              Set the hourly rate families pay for your time — within the range we reserve for your
              tier. A higher certification unlocks a wider band.
            </p>
            <p>
              <a href="/dashboard/pricing">Set your rate →</a>
            </p>
          </article>
          <article className="dash-card">
            <h2>Earnings &amp; payouts</h2>
            <p>
              We pay weekly by direct deposit. Your earnings dashboard, commission breakdown, and
              1099 tax documents will appear here once your first visit is complete.
            </p>
          </article>
        </div>
      </main>
    </div>
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
