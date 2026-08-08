import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminSubscriptionDetailResponseSchema,
  MeResponseSchema,
  type AdminSubscriptionDetail,
  type AdminSubscriptionDunningSummary,
  type AdminSubscriptionHistoryEntry,
  type AdminSubscriptionPauseSummary,
  type AdminSubscriptionPaymentMethodSummary,
  type AdminSubscriptionPlanSummary,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Subscription detail — Taste & See Admin',
};

/**
 * Admin subscription detail (TS-127 Slice 1; PRD §10.3).
 *
 * Single-page view of one subscription: identity columns + denormalised
 * plan summary, default payment-method summary, dunning state, pause
 * state, cancellation state, and the chronological change-history audit
 * trail. Read-only — Slice 1 has no mutations.
 *
 * Mutations (comp / refund / extend-trial / prorate / pause / resume
 * admin overrides — TS-127-followup-1), plan-catalog edit
 * (TS-127-followup-2), bulk cohort operations (TS-127-followup-3), and
 * the rest of the follow-ups arrive in subsequent slices.
 */
export default async function SubscriptionDetailPage({
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

  const detail = await fetchSubscriptionDetail(id);
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
        <span>Admin console — subscription detail</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/subscriptions" className="dash-logout">
            ← All subscriptions
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>{detail.plan.name}</h1>
        <p className="user-detail__sub">
          <span className={`user-row__status user-row__status--${statusBucket(detail.status)}`}>
            {detail.status.replace(/_/g, ' ')}
          </span>
          {detail.dunning.inGracePeriod && (
            <span className="user-row__chip user-row__chip--warn">past due</span>
          )}
          {detail.pause.isPaused && <span className="user-row__chip">paused</span>}
          {detail.cancelAtPeriodEnd && !detail.pause.isPaused && (
            <span className="user-row__chip">cancel scheduled</span>
          )}
        </p>

        <IdentitySection detail={detail} />
        <PlanSection plan={detail.plan} interval={detail.billingInterval} />
        <PaymentMethodSection method={detail.defaultPaymentMethod} />
        <DunningSection dunning={detail.dunning} />
        <PauseSection pause={detail.pause} />
        <CancellationSection detail={detail} />
        <HistorySection history={detail.history} />

        <section className="user-detail__section user-detail__section--placeholder">
          <h2>Actions</h2>
          <p>
            Comp, refund, extend-trial, prorate, pause, and resume admin overrides arrive in later
            slices of TS-127. The audit log of every admin action lands with TS-100.
          </p>
        </section>
      </main>
    </div>
  );
}

function IdentitySection({
  detail,
}: {
  readonly detail: AdminSubscriptionDetail;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Identity</h2>
      <dl className="user-detail__dl">
        <dt>Subscription id</dt>
        <dd className="user-detail__mono">{detail.id}</dd>
        <dt>Stripe subscription</dt>
        <dd className="user-detail__mono">{detail.stripeSubscriptionId}</dd>
        <dt>Stripe customer</dt>
        <dd className="user-detail__mono">{detail.stripeCustomerId}</dd>
        <dt>Customer id</dt>
        <dd className="user-detail__mono">
          {detail.customerId} <span className="user-detail__hint">({detail.customerGroup})</span>
        </dd>
        <dt>Billing</dt>
        <dd>
          {formatMoney(detail.unitPriceMinor, detail.currency)}{' '}
          <span className="user-detail__hint">/ {detail.billingInterval}</span>
        </dd>
        <dt>Current period</dt>
        <dd>
          {formatDateTime(detail.currentPeriodStart)} → {formatDateTime(detail.currentPeriodEnd)}
        </dd>
        <dt>Trial ends</dt>
        <dd>
          {detail.trialEnd !== null ? (
            formatDateTime(detail.trialEnd)
          ) : (
            <span className="user-detail__hint">none</span>
          )}
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(detail.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDateTime(detail.updatedAt)}</dd>
      </dl>
    </section>
  );
}

function PlanSection({
  plan,
  interval,
}: {
  readonly plan: AdminSubscriptionPlanSummary;
  readonly interval: AdminSubscriptionDetail['billingInterval'];
}): React.JSX.Element {
  const intervalPriceMinor =
    interval === 'monthly' ? plan.monthlyPriceMinor : plan.annualPriceMinor;
  return (
    <section className="user-detail__section">
      <h2>Plan</h2>
      <dl className="user-detail__dl">
        <dt>Code</dt>
        <dd className="user-detail__mono">{plan.code}</dd>
        <dt>Name</dt>
        <dd>{plan.name}</dd>
        <dt>Customer group</dt>
        <dd>{plan.customerGroup}</dd>
        <dt>Active</dt>
        <dd>
          {plan.active ? (
            'yes'
          ) : (
            <span className="user-row__chip user-row__chip--warn">retired</span>
          )}
        </dd>
        <dt>Monthly</dt>
        <dd>{formatMoney(plan.monthlyPriceMinor, plan.currency)}</dd>
        <dt>Annual</dt>
        <dd>{formatMoney(plan.annualPriceMinor, plan.currency)}</dd>
        <dt>Current interval price</dt>
        <dd>{formatMoney(intervalPriceMinor, plan.currency)}</dd>
      </dl>
    </section>
  );
}

function PaymentMethodSection({
  method,
}: {
  readonly method: AdminSubscriptionPaymentMethodSummary | null;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Default payment method</h2>
      {method === null ? (
        <p className="user-detail__hint">
          No default payment method on file. (Common for incomplete subscriptions.)
        </p>
      ) : (
        <dl className="user-detail__dl">
          <dt>Kind</dt>
          <dd>{method.kind.replace(/_/g, ' ')}</dd>
          {method.brand !== null && (
            <>
              <dt>Brand</dt>
              <dd>{method.brand}</dd>
            </>
          )}
          {method.last4 !== null && (
            <>
              <dt>Last 4</dt>
              <dd className="user-detail__mono">•••• {method.last4}</dd>
            </>
          )}
          {method.expiryMonth !== null && method.expiryYear !== null && (
            <>
              <dt>Expires</dt>
              <dd>
                {String(method.expiryMonth).padStart(2, '0')} / {method.expiryYear}
              </dd>
            </>
          )}
          <dt>Stripe id</dt>
          <dd className="user-detail__mono">{method.stripePaymentMethodId}</dd>
        </dl>
      )}
    </section>
  );
}

function DunningSection({
  dunning,
}: {
  readonly dunning: AdminSubscriptionDunningSummary;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Dunning state</h2>
      <dl className="user-detail__dl">
        <dt>In grace period</dt>
        <dd>
          {dunning.inGracePeriod ? (
            <strong>yes</strong>
          ) : (
            <span className="user-detail__hint">no</span>
          )}
        </dd>
        <dt>Retry attempts</dt>
        <dd>{dunning.attempts}</dd>
        <dt>Last attempt</dt>
        <dd>
          {dunning.lastAttemptAt !== null ? (
            formatDateTime(dunning.lastAttemptAt)
          ) : (
            <span className="user-detail__hint">none</span>
          )}
        </dd>
        <dt>Grace until</dt>
        <dd>
          {dunning.graceUntil !== null ? (
            formatDateTime(dunning.graceUntil)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

function PauseSection({
  pause,
}: {
  readonly pause: AdminSubscriptionPauseSummary;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Pause state</h2>
      <dl className="user-detail__dl">
        <dt>Currently paused</dt>
        <dd>
          {pause.isPaused ? <strong>yes</strong> : <span className="user-detail__hint">no</span>}
        </dd>
        <dt>Paused at</dt>
        <dd>
          {pause.pauseCollectionStartedAt !== null ? (
            formatDateTime(pause.pauseCollectionStartedAt)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
        <dt>Auto-resumes at</dt>
        <dd>
          {pause.pauseCollectionResumesAt !== null ? (
            formatDateTime(pause.pauseCollectionResumesAt)
          ) : (
            <span className="user-detail__hint">indefinite</span>
          )}
        </dd>
        {pause.pauseReason !== null && (
          <>
            <dt>Reason</dt>
            <dd>{pause.pauseReason}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function CancellationSection({
  detail,
}: {
  readonly detail: AdminSubscriptionDetail;
}): React.JSX.Element {
  if (!detail.cancelAtPeriodEnd && detail.canceledAt === null) {
    return (
      <section className="user-detail__section">
        <h2>Cancellation state</h2>
        <p className="user-detail__hint">Not scheduled for cancellation.</p>
      </section>
    );
  }
  return (
    <section className="user-detail__section">
      <h2>Cancellation state</h2>
      <dl className="user-detail__dl">
        <dt>Cancel at period end</dt>
        <dd>{detail.cancelAtPeriodEnd ? 'yes' : 'no'}</dd>
        <dt>Canceled at</dt>
        <dd>
          {detail.canceledAt !== null ? (
            formatDateTime(detail.canceledAt)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
        <dt>Reason</dt>
        <dd>
          {detail.cancelReason !== null ? (
            detail.cancelReason.replace(/_/g, ' ')
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

function HistorySection({
  history,
}: {
  readonly history: readonly AdminSubscriptionHistoryEntry[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Change history</h2>
      {history.length === 0 ? (
        <p className="user-detail__hint">No history entries on file.</p>
      ) : (
        <ul className="user-detail__role-list">
          {history.map((entry) => (
            <li key={entry.id}>
              <span className="user-detail__role-name">{entry.event}</span>
              <span className="user-detail__hint"> · {entry.actorKind}</span>
              {entry.fromStatus !== null && entry.toStatus !== null && (
                <span className="user-detail__hint">
                  {' '}
                  · {entry.fromStatus} → {entry.toStatus}
                </span>
              )}
              <div className="user-detail__hint">
                {formatDateTime(entry.occurredAt)}
                {entry.actorUserId !== null && <> · actor {entry.actorUserId}</>}
                {entry.source !== null && <> · source {entry.source}</>}
              </div>
            </li>
          ))}
        </ul>
      )}
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

async function fetchSubscriptionDetail(
  id: string,
): Promise<AdminSubscriptionDetail | 'not_found' | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/subscriptions/${encodeURIComponent(id)}`,
  );
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 404) return 'not_found';
  if (result.kind !== 'ok') return null;
  const parsed = AdminSubscriptionDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.subscription : null;
}

/** Same status-bucket mapping the list page uses. */
function statusBucket(
  status: AdminSubscriptionDetail['status'],
): 'active' | 'suspended' | 'deactivated' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'paused':
    case 'incomplete':
    case 'incomplete_expired':
      return 'suspended';
    case 'unpaid':
    case 'canceled':
      return 'deactivated';
  }
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
