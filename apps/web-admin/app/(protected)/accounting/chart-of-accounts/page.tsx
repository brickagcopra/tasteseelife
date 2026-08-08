import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ADMIN_ACCOUNTS_ACTIVE_REASONS,
  AccountsListResponseSchema,
  MeResponseSchema,
  type Account,
  type AccountsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import { setAccountActiveAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Chart of accounts — Taste & See Admin',
};

const ACCOUNT_TYPE_ORDER: readonly Account['type'][] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'contra_revenue',
  'expense',
];

/**
 * Admin chart-of-accounts browser (TS-129-followup-1; PRD §10.8,
 * CLAUDE.md §6).
 *
 * Lists every chart-of-accounts row — active + retired — grouped by
 * account type in the canonical accounting order
 * (asset → liability → equity → revenue → contra-revenue → expense).
 * Each row has a Retire / Activate button gated behind a reason
 * select + optional free-text note.
 *
 * CLAUDE.md §6 forbids deleting a chart-of-accounts row — historical
 * journals point at it forever — so retirement is the closest "delete"
 * gesture available. Re-activation is the inverse.
 *
 * Phase-1 admin gating: only super_admins land here. Per-permission
 * gating (`accounting:adjust`) arrives once `PermissionGuard` lifts to
 * `packages/nest-auth` (TS-129-followup-2 / TS-052-followup-11).
 */
export default async function ChartOfAccountsPage({
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

  const list = await fetchAccounts();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — chart of accounts</span>
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
        <h1>Chart of accounts</h1>
        <p>
          The double-entry ledger&apos;s account catalog. Active accounts back new journal lines;
          retired accounts back only historical lines. Retiring an account does not delete it —
          historical journals always remain inspectable.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the chart of accounts right now. The downstream accounting service
            may be unreachable.
          </p>
        ) : (
          <AccountsByType list={list} />
        )}
      </main>
    </div>
  );
}

function AccountsByType({ list }: { readonly list: AccountsListResponse }): React.JSX.Element {
  const groups = new Map<Account['type'], Account[]>();
  for (const account of list.accounts) {
    const existing = groups.get(account.type) ?? [];
    existing.push(account);
    groups.set(account.type, existing);
  }
  for (const accounts of groups.values()) {
    accounts.sort((a, b) => a.code.localeCompare(b.code));
  }

  if (list.accounts.length === 0) {
    return (
      <div className="user-empty">
        <p>No chart-of-accounts rows yet. Seed the catalog first.</p>
      </div>
    );
  }

  return (
    <>
      {ACCOUNT_TYPE_ORDER.map((type) => {
        const accounts = groups.get(type);
        if (accounts === undefined || accounts.length === 0) return null;
        return (
          <section key={type} className="user-detail__section">
            <h2>{formatAccountType(type)}</h2>
            <div className="user-table" role="table" aria-label={`Accounts — ${type}`}>
              <div className="user-table__head" role="row">
                <span role="columnheader">Code</span>
                <span role="columnheader">Name</span>
                <span role="columnheader">Normal balance</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Action</span>
              </div>
              {accounts.map((account) => (
                <AccountRow key={account.id} account={account} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function AccountRow({ account }: { readonly account: Account }): React.JSX.Element {
  const target = account.active ? 'retire' : 'activate';
  const verb = account.active ? 'Retire' : 'Activate';
  const reasonOptions = account.active
    ? (['superseded', 'chart_cleanup', 'other'] as const)
    : (['restore', 'other'] as const);
  const setActiveBound = setAccountActiveAction.bind(null, account.id);

  return (
    <div className="user-row" role="row">
      <span role="cell" className="user-row__email">
        <code>{account.code}</code>
      </span>
      <span role="cell">
        {account.name}
        {account.description !== undefined && (
          <div className="user-detail__hint">{account.description}</div>
        )}
      </span>
      <span role="cell">{account.normalBalance}</span>
      <span role="cell">
        {account.active ? (
          <span className="user-row__status user-row__status--active">active</span>
        ) : (
          <span className="user-row__status user-row__status--suspended">retired</span>
        )}
      </span>
      <span role="cell">
        <form action={setActiveBound} className="user-detail__action-form">
          <input type="hidden" name="target" value={target} />
          <label className="filter-bar__field">
            <span className="visually-hidden">Reason</span>
            <select name="reason" defaultValue="" required>
              <option value="" disabled>
                Reason…
              </option>
              {reasonOptions.map((r) => (
                <option key={r} value={r}>
                  {formatReason(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-bar__field">
            <span className="visually-hidden">Note</span>
            <input
              type="text"
              name="note"
              placeholder="Optional note"
              maxLength={500}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="filter-bar__submit">
            {verb}
          </button>
        </form>
      </span>
    </div>
  );
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Chart of accounts updated.
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
    case 'not-found':
      return "We couldn't find that account — it may have been removed.";
    case 'reason-required':
      return 'Please choose a reason before retiring or activating an account.';
    case 'target-invalid':
      return 'The action target was missing or invalid. Please refresh and try again.';
    case 'bad-request':
      return 'The update was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The accounting service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
}

function formatAccountType(type: Account['type']): string {
  switch (type) {
    case 'asset':
      return 'Assets';
    case 'liability':
      return 'Liabilities';
    case 'equity':
      return 'Equity';
    case 'revenue':
      return 'Revenue';
    case 'contra_revenue':
      return 'Contra-revenue';
    case 'expense':
      return 'Expense';
  }
}

function formatReason(reason: (typeof ADMIN_ACCOUNTS_ACTIVE_REASONS)[number]): string {
  switch (reason) {
    case 'superseded':
      return 'Superseded';
    case 'chart_cleanup':
      return 'Chart cleanup';
    case 'restore':
      return 'Restore';
    case 'other':
      return 'Other';
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

async function fetchAccounts(): Promise<AccountsListResponse | null> {
  // `activeOnly=false` so the admin sees retired accounts alongside
  // active ones. The downstream `GET /api/v1/accounts` accepts the
  // literal string `'false'`.
  const result = await callGateway<unknown>('/api/v1/admin/accounts?activeOnly=false');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AccountsListResponseSchema.safeParse(result.body);
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
