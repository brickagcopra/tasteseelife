import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminPausedDeferredRevenueResponseSchema,
  MeResponseSchema,
  type AdminPausedDeferredRevenueBalance,
  type AdminPausedDeferredRevenueResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import { describePausedBalance, describePausedQueue } from '@/lib/paused-balances';

export const metadata: Metadata = {
  title: 'Paused deferred revenue — Taste & See Admin',
};

/**
 * Suspended deferred-revenue queue (TS-042-followup-3b2-followup-2a;
 * PRD §10.8, PDD §11.2).
 *
 * The stock counterpart to `accounting_recognition_pause_total`: which
 * balances have stopped amortising, for how long, and how much revenue is
 * suspended inside them.
 *
 * **The copy states measurements, never verdicts** (the TS-308c-followup-2
 * console rule). A long pause is ordinary product behaviour — a family can
 * suspend care for a hospital stay — so nothing here calls a row broken.
 * What the page does say plainly is when a suspension has outlasted the
 * service period it belongs to, because that comparison comes off the row
 * and needs no judgement.
 */
export default async function PausedDeferredRevenuePage(): Promise<React.JSX.Element> {
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

  const queue = await fetchPausedQueue();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — paused deferred revenue</span>
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
        <h1>Paused deferred revenue</h1>
        <p>
          Deferred-revenue balances whose amortisation is suspended. A subscription pause stops
          recognition and extends the service period by the suspended time when it resumes — so a
          balance that is still paused after its service period has ended has stopped amortising
          with nothing scheduled to restart it.
        </p>

        {queue === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the paused-balance queue right now. The downstream accounting
            service may be unreachable — this is not the same as nothing being paused.
          </p>
        ) : (
          <QueueView queue={queue} />
        )}
      </main>
    </div>
  );
}

function QueueView({
  queue,
}: {
  readonly queue: AdminPausedDeferredRevenueResponse;
}): React.JSX.Element {
  const summary = describePausedQueue(queue);

  return (
    <>
      <p className="user-detail__sub">
        Measured at <strong>{formatInstant(queue.asOf)}</strong>
      </p>

      <div className="user-table" role="table" aria-label="Paused balance summary">
        <div className="user-row" role="row">
          <span role="cell">Balances paused</span>
          <span role="cell">
            <strong>{queue.summary.pausedCount}</strong>
          </span>
        </div>
        <div className="user-row" role="row">
          <span role="cell">Past their own service period end</span>
          <span role="cell">
            {queue.summary.pastServicePeriodEndCount > 0 ? (
              <strong className="user-row__chip user-row__chip--warn">
                {queue.summary.pastServicePeriodEndCount}
              </strong>
            ) : (
              <strong>0</strong>
            )}
          </span>
        </div>
        <div className="user-row" role="row">
          <span role="cell">Deferred revenue suspended</span>
          <span role="cell">
            <strong>
              {formatMoney(queue.summary.totalRemainingDeferredMinor, queue.summary.currency)}
            </strong>
          </span>
        </div>
        <div className="user-row" role="row">
          <span role="cell">Oldest recorded pause</span>
          <span role="cell">
            {queue.summary.oldestPausedAt === null ? (
              <em>none recorded</em>
            ) : (
              formatInstant(queue.summary.oldestPausedAt)
            )}
          </span>
        </div>
      </div>

      {summary.notes.map((note) => (
        <p key={note} className="user-detail__sub">
          {note}
        </p>
      ))}

      {queue.balances.length === 0 ? (
        <div className="user-empty">
          <p>Nothing is paused. Every deferred-revenue balance is amortising.</p>
        </div>
      ) : (
        <div className="user-table" role="table" aria-label="Paused balances">
          <div className="user-table__head" role="row">
            <span role="columnheader">Subscription</span>
            <span role="columnheader">Plan</span>
            <span role="columnheader">Paused for</span>
            <span role="columnheader">Service period ends</span>
            <span role="columnheader">Suspended</span>
          </div>
          {queue.balances.map((balance) => (
            <BalanceRow key={balance.balanceId} balance={balance} />
          ))}
        </div>
      )}
    </>
  );
}

function BalanceRow({
  balance,
}: {
  readonly balance: AdminPausedDeferredRevenueBalance;
}): React.JSX.Element {
  const described = describePausedBalance(balance);

  return (
    <div className="user-row" role="row">
      <span role="cell">
        <span className="user-row__email">{balance.subscriptionId}</span>
        <span className="user-row__date"> {balance.customerGroup}</span>
      </span>
      <span role="cell">
        <span className="user-row__chip">{balance.planCode}</span>
      </span>
      <span role="cell">
        {described.age === null ? (
          <span className="user-row__chip user-row__chip--warn">no pause instant</span>
        ) : (
          described.age
        )}
      </span>
      <span role="cell">
        {formatInstant(balance.servicePeriodEnd)}
        {balance.pastServicePeriodEnd ? (
          <>
            {' '}
            <span className="user-row__chip user-row__chip--warn">period ended</span>
          </>
        ) : null}
      </span>
      <span role="cell">{formatMoney(balance.remainingDeferredMinor, balance.currency)}</span>
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

async function fetchPausedQueue(): Promise<AdminPausedDeferredRevenueResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/deferred-revenue/paused');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminPausedDeferredRevenueResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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
