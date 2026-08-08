import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminJournalDetailResponseSchema,
  MeResponseSchema,
  type AdminJournalDetail,
  type AdminJournalLine,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Journal detail — Taste & See Admin',
};

/**
 * Admin journal detail (TS-129 Slice 1; PRD §10.8).
 *
 * One-page view: envelope columns + line table + context jsonb.
 * Distinguishes a 404 from a downstream failure so the UX is precise.
 */
export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ readonly id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
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

  const detail = await fetchJournalDetail(id);
  if (detail === 'not_found') notFound();
  if (detail === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — journal detail</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/accounting/journals" className="dash-logout">
            ← All journals
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>{formatKind(detail.kind)}</h1>
        <p className="user-detail__sub">
          {detail.reversedByJournalId !== null && <span className="user-row__chip">reversed</span>}
          {detail.reversedJournalId !== null && <span className="user-row__chip">reversal</span>}
          <span className="user-row__date">{formatDateTime(detail.occurredAt)}</span>
        </p>

        <IdentitySection detail={detail} />
        <LinesSection lines={detail.lines} currency={detail.currency} />
        <TotalsSection detail={detail} />
        <ContextSection context={detail.context} />
      </main>
    </div>
  );
}

function IdentitySection({ detail }: { readonly detail: AdminJournalDetail }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Identity</h2>
      <dl className="user-detail__dl">
        <dt>Id</dt>
        <dd>{detail.id}</dd>
        <dt>Kind</dt>
        <dd>{formatKind(detail.kind)}</dd>
        <dt>Source event id</dt>
        <dd>{detail.sourceEventId}</dd>
        <dt>Description</dt>
        <dd>{detail.description}</dd>
        <dt>Period</dt>
        <dd>
          {detail.periodName}
          <span className="user-row__date"> (id {detail.periodId})</span>
        </dd>
        <dt>Posted by</dt>
        <dd>{detail.postedByUserId ?? <em>system</em>}</dd>
        <dt>Occurred</dt>
        <dd>{formatDateTime(detail.occurredAt)}</dd>
        <dt>Posted</dt>
        <dd>{formatDateTime(detail.postedAt)}</dd>
        {detail.reversedByJournalId !== null && (
          <>
            <dt>Reversed by</dt>
            <dd>
              <Link href={`/accounting/journals/${encodeURIComponent(detail.reversedByJournalId)}`}>
                {detail.reversedByJournalId}
              </Link>
            </dd>
          </>
        )}
        {detail.reversedJournalId !== null && (
          <>
            <dt>Reverses</dt>
            <dd>
              <Link href={`/accounting/journals/${encodeURIComponent(detail.reversedJournalId)}`}>
                {detail.reversedJournalId}
              </Link>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function LinesSection({
  lines,
  currency,
}: {
  readonly lines: readonly AdminJournalLine[];
  readonly currency: string;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Lines</h2>
      <div className="user-table" role="table" aria-label="Journal lines">
        <div className="user-table__head" role="row">
          <span role="columnheader">Account</span>
          <span role="columnheader">Debit</span>
          <span role="columnheader">Credit</span>
          <span role="columnheader">Memo</span>
        </div>
        {lines.map((line) => (
          <div key={line.id} className="user-row" role="row">
            <span role="cell">
              <span className="user-row__email">{line.accountCode}</span>
              <span className="user-row__date"> {line.accountName}</span>
            </span>
            <span role="cell">
              {line.debitMinor > 0 ? formatMoney(line.debitMinor, currency) : ''}
            </span>
            <span role="cell">
              {line.creditMinor > 0 ? formatMoney(line.creditMinor, currency) : ''}
            </span>
            <span role="cell">{line.memo ?? ''}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TotalsSection({ detail }: { readonly detail: AdminJournalDetail }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Totals</h2>
      <dl className="user-detail__dl">
        <dt>Total debit</dt>
        <dd>{formatMoney(detail.totalDebitMinor, detail.currency)}</dd>
        <dt>Total credit</dt>
        <dd>{formatMoney(detail.totalCreditMinor, detail.currency)}</dd>
        <dt>Currency</dt>
        <dd>{detail.currency}</dd>
      </dl>
    </section>
  );
}

function ContextSection({
  context,
}: {
  readonly context: Record<string, unknown>;
}): React.JSX.Element {
  const entries = Object.entries(context);
  if (entries.length === 0) {
    return (
      <section className="user-detail__section">
        <h2>Context</h2>
        <p>
          <em>(no context payload)</em>
        </p>
      </section>
    );
  }
  return (
    <section className="user-detail__section">
      <h2>Context</h2>
      <pre className="user-detail__pre">{JSON.stringify(context, null, 2)}</pre>
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

async function fetchJournalDetail(id: string): Promise<AdminJournalDetail | null | 'not_found'> {
  const result = await callGateway<unknown>(`/api/v1/admin/journals/${encodeURIComponent(id)}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 404) {
    return 'not_found';
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminJournalDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.journal : null;
}

function formatKind(kind: AdminJournalDetail['kind']): string {
  const words = kind.split('_');
  return words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
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
