import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { InvoicesListResponseSchema, type InvoiceResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { formatUsdMinor } from '@/lib/plans-api';

export const metadata: Metadata = {
  title: 'Invoices — Taste & See',
  robots: { index: false, follow: false },
};

interface InvoicesPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Family-portal invoices page (TS-124).
 *
 * Server component that lists the customer's Stripe invoices for a
 * given local subscription. The page accepts a `?subscriptionId=...`
 * query param (the local `subscriptions.id` returned by the checkout
 * finalize step) and surfaces a paginated table with hosted-page +
 * PDF links served by Stripe.
 *
 * No local persistence — Stripe is authoritative for invoice state in
 * Phase 1 (see InvoicesService doc-comment). The portal renders
 * whatever Stripe currently shows.
 *
 * Missing `subscriptionId`: surfaces a brief explainer rather than a
 * blank page. A future iteration (TS-124-followup-3) lifts the user's
 * subscription id from their dashboard / household scope so the page
 * works without a query string.
 */
export default async function InvoicesPage({
  searchParams,
}: InvoicesPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const rawSubscriptionId = params.subscriptionId;
  const subscriptionId = typeof rawSubscriptionId === 'string' ? rawSubscriptionId.trim() : '';
  if (subscriptionId.length === 0) {
    return <Empty />;
  }

  const result = await callGateway<unknown>(
    `/api/v1/invoices?subscriptionId=${encodeURIComponent(subscriptionId)}`,
  );
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  // A 4xx here is not an outage and must not read as one. Since
  // TS-124-followup-scoping the endpoint is household-scoped, so a 404
  // means "not a subscription of yours" (deliberately indistinguishable
  // from "no such subscription") and a 400 means the caller has no
  // household scope. Both are answered by the same page: a stale or
  // borrowed link, not something to refresh at.
  if (result.kind === 'client_error') {
    return <Unavailable />;
  }
  if (result.kind !== 'ok') {
    return <ServiceWarning />;
  }
  const parsed = InvoicesListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return <ServiceWarning />;
  }

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your invoices</h1>
        <p>
          Every receipt for your Taste &amp; See plan, kept where you can find it. Stripe generates
          and stores these for you — we surface them here for easy access.
        </p>
        <p>
          To change the card we charge,{' '}
          <Link href="/billing" className="link-inline">
            go to your billing details
          </Link>
          .
        </p>

        {parsed.data.invoices.length === 0 ? (
          <p>No invoices yet. They&apos;ll appear here after your first billing cycle.</p>
        ) : (
          <ul className="invoices-list">
            {parsed.data.invoices.map((invoice) => (
              <InvoiceRow key={invoice.id} invoice={invoice} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function InvoiceRow({ invoice }: { readonly invoice: InvoiceResponse }): React.JSX.Element {
  const created = new Date(invoice.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const amount = formatUsdMinor(invoice.amountDueUsdMinor);
  const statusLabel = humanStatus(invoice.status);

  return (
    <li className="invoice-card">
      <div className="invoice-card-main">
        <div>
          <span className="invoice-number">{invoice.number ?? invoice.id}</span>
          <span className="invoice-date"> · {created}</span>
        </div>
        <div className="invoice-amount">
          <strong>{amount}</strong>
          <span className={`invoice-status invoice-status--${invoice.status}`}>{statusLabel}</span>
        </div>
      </div>
      {invoice.description !== null ? <p className="invoice-desc">{invoice.description}</p> : null}
      <div className="invoice-actions">
        {invoice.hostedInvoiceUrl !== null ? (
          <a
            className="link-inline"
            href={invoice.hostedInvoiceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View receipt
          </a>
        ) : null}
        {invoice.invoicePdf !== null ? (
          <a
            className="link-inline"
            href={invoice.invoicePdf}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download PDF
          </a>
        ) : null}
      </div>
    </li>
  );
}

function humanStatus(status: InvoiceResponse['status']): string {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'open':
      return 'Due';
    case 'draft':
      return 'Draft';
    case 'uncollectible':
      return 'Action required';
    case 'void':
      return 'Voided';
  }
}

function Empty(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your invoices</h1>
        <p>
          Open this page from your subscription confirmation to see receipts for that plan.
          (We&apos;ll surface invoices directly on your dashboard in a future update.)
        </p>
        <Link href="/dashboard" className="cta">
          Back to your dashboard
        </Link>
      </main>
    </div>
  );
}

/**
 * The answer to every 4xx on this page. Deliberately says nothing about
 * whether the named subscription exists — the endpoint refuses to tell
 * us, and repeating a guess back to the reader would undo that.
 */
function Unavailable(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>We can&apos;t open those invoices</h1>
        <p>
          This link doesn&apos;t match a plan on your account. It may have been shared from someone
          else&apos;s household, or it may be out of date. Your own receipts are always reachable
          from your dashboard.
        </p>
        <Link href="/dashboard" className="cta">
          Back to your dashboard
        </Link>
      </main>
    </div>
  );
}

function ServiceWarning(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>Invoices are taking a moment</h1>
        <p>We&apos;re briefly unable to read your invoices. Please refresh in a few seconds.</p>
        <Link href="/dashboard" className="link-back">
          Back to your dashboard
        </Link>
      </main>
    </div>
  );
}
