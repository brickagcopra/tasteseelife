import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminTrialBalanceResponseSchema,
  MeResponseSchema,
  type AdminTrialBalanceResponse,
  type AdminTrialBalanceRow,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Trial balance — Taste & See Admin',
};

interface ScopeFilter {
  readonly periodId: string | null;
  readonly periodName: string | null;
}

/**
 * Trial balance read view (TS-129 Slice 1; PRD §10.8, PDD §11.2).
 *
 * Per-account aggregates with optional period scope. Footer carries
 * the grand totals + an imbalance diagnostic.
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
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

  const scope: ScopeFilter = {
    periodId: stringParam(params['periodId']),
    periodName: stringParam(params['periodName']),
  };

  const balance = await fetchTrialBalance(scope);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — trial balance</span>
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
        <h1>Trial balance</h1>
        <p>
          Per-account gross debit + gross credit + signed net, summed across the queried scope. The
          imbalance footer flags any divergence — for a healthy ledger it is zero.
        </p>

        <ScopeFilters initial={scope} />

        {balance === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the trial balance right now. The downstream accounting service may
            be unreachable.
          </p>
        ) : (
          <BalanceView balance={balance} />
        )}
      </main>
    </div>
  );
}

function ScopeFilters({ initial }: { readonly initial: ScopeFilter }): React.JSX.Element {
  return (
    <form action="/accounting/trial-balance" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Period (YYYY-MM)</span>
        <input
          type="text"
          name="periodName"
          defaultValue={initial.periodName ?? ''}
          placeholder="2026-05"
          autoComplete="off"
          pattern="\d{4}-(0[1-9]|1[0-2])"
        />
      </label>
      <label className="filter-bar__field">
        <span>Period id</span>
        <input
          type="text"
          name="periodId"
          defaultValue={initial.periodId ?? ''}
          placeholder="per_..."
          autoComplete="off"
        />
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply
        </button>
        <Link href="/accounting/trial-balance" className="filter-bar__reset">
          All-time
        </Link>
      </div>
    </form>
  );
}

function BalanceView({
  balance,
}: {
  readonly balance: AdminTrialBalanceResponse;
}): React.JSX.Element {
  if (balance.rows.length === 0) {
    return (
      <div className="user-empty">
        <p>
          No accounts to report{' '}
          {balance.periodName !== null ? `for period ${balance.periodName}` : ''}.
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="user-detail__sub">
        Scope:{' '}
        {balance.periodName !== null ? <strong>{balance.periodName}</strong> : <em>all-time</em>}
        {' · '}
        Currency: <strong>{balance.currency}</strong>
        {balance.imbalanceMinor > 0 ? (
          <>
            {' · '}
            <span className="user-row__chip user-row__chip--warn">
              imbalance {formatMoney(balance.imbalanceMinor, balance.currency)}
            </span>
          </>
        ) : (
          <>
            {' · '}
            <span className="user-row__chip">balanced</span>
          </>
        )}
      </p>
      <div className="user-table" role="table" aria-label="Trial balance">
        <div className="user-table__head" role="row">
          <span role="columnheader">Account</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Debit total</span>
          <span role="columnheader">Credit total</span>
          <span role="columnheader">Net</span>
        </div>
        {balance.rows.map((row) => (
          <BalanceRow key={row.accountId} row={row} />
        ))}
        <div className="user-row user-row--total" role="row">
          <span role="cell">
            <strong>Totals</strong>
          </span>
          <span role="cell" />
          <span role="cell">
            <strong>{formatMoney(balance.totalDebitMinor, balance.currency)}</strong>
          </span>
          <span role="cell">
            <strong>{formatMoney(balance.totalCreditMinor, balance.currency)}</strong>
          </span>
          <span role="cell">
            {balance.imbalanceMinor > 0 ? (
              <strong className="user-row__chip user-row__chip--warn">
                ±{formatMoney(balance.imbalanceMinor, balance.currency)}
              </strong>
            ) : (
              <strong>—</strong>
            )}
          </span>
        </div>
      </div>
    </>
  );
}

function BalanceRow({ row }: { readonly row: AdminTrialBalanceRow }): React.JSX.Element {
  const netLabel =
    row.netDebitMinor > 0
      ? `DR ${formatMoney(row.netDebitMinor, row.currency)}`
      : row.netCreditMinor > 0
        ? `CR ${formatMoney(row.netCreditMinor, row.currency)}`
        : '—';
  return (
    <div className="user-row" role="row">
      <span role="cell">
        <span className="user-row__email">{row.accountCode}</span>
        <span className="user-row__date"> {row.accountName}</span>
      </span>
      <span role="cell">
        <span className="user-row__chip">{row.accountType.replace(/_/g, ' ')}</span>
      </span>
      <span role="cell">{formatMoney(row.debitTotalMinor, row.currency)}</span>
      <span role="cell">{formatMoney(row.creditTotalMinor, row.currency)}</span>
      <span role="cell">{netLabel}</span>
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

async function fetchTrialBalance(scope: ScopeFilter): Promise<AdminTrialBalanceResponse | null> {
  const query = new URLSearchParams();
  if (scope.periodId !== null) query.set('periodId', scope.periodId);
  if (scope.periodName !== null) query.set('periodName', scope.periodName);
  const qs = query.toString();
  const path = qs.length > 0 ? `/api/v1/admin/trial-balance?${qs}` : '/api/v1/admin/trial-balance';

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminTrialBalanceResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
