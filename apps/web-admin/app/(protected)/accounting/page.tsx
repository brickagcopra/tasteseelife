import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Accounting — Taste & See Admin',
};

/**
 * Admin accounting landing (TS-129 Slice 1 + TS-129-followup-1;
 * PRD §10.8, PDD §11.2).
 *
 * Cards into the accounting read surfaces:
 *
 *   - Journals — paginated journal browser with kind + period filters.
 *   - Trial balance — per-account net balance, optionally period-scoped.
 *   - Period events — per-period close/reopen lifecycle audit.
 *   - Chart of accounts — retire / activate toggle over the account
 *     catalog (TS-129-followup-1).
 *   - SaaS metrics — recurring-revenue dashboard over the nightly
 *     `saas_metrics_daily` series (TS-266).
 *   - Paused deferred revenue — the suspended-balance ops queue
 *     (TS-042-followup-3b2-followup-2a).
 *
 * Phase-1 admin gating: only super_admins land here. Finance-role
 * gating arrives once per-permission gating lifts to
 * `packages/nest-auth` (TS-052-followup-11).
 */
export default async function AccountingPage(): Promise<React.JSX.Element> {
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

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — accounting</span>
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
        <h1>Accounting</h1>
        <p>
          The financial source of truth. Browse the double-entry journal ledger, inspect per-account
          balances on the trial balance, and audit period close / reopen lifecycle events. Read-only
          at launch — every mutation is recorded in the immutable audit log when those surfaces
          land.
        </p>

        <div className="dash-cards">
          <article className="dash-card">
            <h2>Journals</h2>
            <p>
              Browse every posted journal across subscription activation, recognition, booking
              completion, payout, refund, coupon, and manual-adjustment kinds. Filter by period and
              by kind; drill into a journal to see its balanced line shape.
            </p>
            <Link href="/accounting/journals" className="dash-card__cta">
              Open journals →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Trial balance</h2>
            <p>
              Per-account gross debit + gross credit + signed net across the queried scope. Optional
              period filter; defaults to all-time. The footer flags any imbalance — for a healthy
              ledger it is zero.
            </p>
            <Link href="/accounting/trial-balance" className="dash-card__cta">
              Open trial balance →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Period events</h2>
            <p>
              Per-period close + reopen lifecycle audit. Every transition records the actor, the
              reason code, and the originating source-event id. Useful for the finance close runbook
              and post-close reviews.
            </p>
            <Link
              href={`/accounting/periods/${encodeURIComponent(currentYearMonth())}/events`}
              className="dash-card__cta"
            >
              Open period events →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Chart of accounts</h2>
            <p>
              The double-entry ledger&apos;s account catalog, grouped by type. Retire or activate an
              account directly from the row — historical journals remain inspectable for retired
              accounts.
            </p>
            <Link href="/accounting/chart-of-accounts" className="dash-card__cta">
              Open chart of accounts →
            </Link>
          </article>
          <article className="dash-card">
            <h2>SaaS metrics</h2>
            <p>
              Recurring-revenue health computed nightly from the ledger — MRR, ARR, ARPU, the new /
              expansion / contraction / churn movement, and net + gross revenue retention.
              Date-range picker, trend sparklines, and CSV export.
            </p>
            <Link href="/accounting/saas-metrics" className="dash-card__cta">
              Open SaaS metrics →
            </Link>
          </article>
          <article className="dash-card">
            <h2>Paused deferred revenue</h2>
            <p>
              Deferred-revenue balances whose amortisation is suspended — how long each has been
              stopped and how much revenue is sitting in them. Flags any balance still paused after
              its own service period has ended.
            </p>
            <Link href="/accounting/deferred-revenue/paused" className="dash-card__cta">
              Open paused balances →
            </Link>
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

/**
 * Today's `YYYY-MM` — used as the default landing target for the
 * period-events drilldown so the "Open period events" card lands on a
 * meaningful page rather than 404'ing with no path parameter.
 */
function currentYearMonth(): string {
  const d = new Date();
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
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
