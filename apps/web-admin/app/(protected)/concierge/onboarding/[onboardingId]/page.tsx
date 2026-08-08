import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  GetConciergeOnboardingResponseSchema,
  MeResponseSchema,
  isConciergeOnboardingTerminal,
  type ConciergeOnboardingDetailRecord,
  type ConciergeOnboardingStepRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { cancelOnboardingAction, updateOnboardingAction, updateStepAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Onboarding detail — Taste & See Admin',
};

/**
 * Tier-3 onboarding detail surface (TS-228). Shows the household's kickoff
 * checklist with a per-step advance form, plus onboarding-level kickoff/notes
 * edit + cancel. Permission-gated on `concierge:read`; the write forms render
 * only for an actor holding `concierge:write` (and never for a canceled
 * onboarding).
 */
export default async function OnboardingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ onboardingId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { onboardingId } = await params;
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
  if (!hasPermission(me, 'concierge:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'concierge:write');

  const onboarding = await fetchOnboarding(onboardingId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Tier 3 onboarding</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/concierge/onboarding" className="dash-logout">
            Back to onboardings
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Onboarding</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {onboarding === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that onboarding — it may have been removed, or the concierge
            service is unreachable.
          </p>
        ) : (
          <OnboardingDetail onboarding={onboarding} canWrite={canWrite} />
        )}
      </main>
    </div>
  );
}

function OnboardingDetail({
  onboarding,
  canWrite,
}: {
  readonly onboarding: ConciergeOnboardingDetailRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  const terminal = isConciergeOnboardingTerminal(onboarding.status);
  const writable = canWrite && !terminal;
  return (
    <>
      <section className="user-detail__section">
        <div className="concierge-event-card__head">
          <span className="concierge-event-card__title">
            <code>{onboarding.householdId}</code>
          </span>
          <span className={statusChipClass(onboarding.status)}>
            {formatLabel(onboarding.status)}
          </span>
        </div>
        <dl className="concierge-detail__facts">
          <FactItem label="Steps complete">
            {onboarding.stepsCompleted} / {onboarding.stepsTotal}
          </FactItem>
          {onboarding.kickoffScheduledAt !== null && (
            <FactItem label="Kickoff call">
              {formatDateTime(onboarding.kickoffScheduledAt)}
            </FactItem>
          )}
          <FactItem label="Started">{formatDateTime(onboarding.createdAt)}</FactItem>
          {onboarding.completedAt !== null && (
            <FactItem label="Completed">{formatDateTime(onboarding.completedAt)}</FactItem>
          )}
          {onboarding.canceledAt !== null && (
            <FactItem label="Canceled">{formatDateTime(onboarding.canceledAt)}</FactItem>
          )}
          {onboarding.notes !== null && <FactItem label="Notes">{onboarding.notes}</FactItem>}
        </dl>
      </section>

      <section className="user-detail__section">
        <h2>Checklist</h2>
        <ul className="onboarding-steps">
          {onboarding.steps.map((step) => (
            <StepRow
              key={step.stepKey}
              onboardingId={onboarding.id}
              step={step}
              writable={writable}
            />
          ))}
        </ul>
      </section>

      {writable && (
        <section className="user-detail__section">
          <h2>Onboarding settings</h2>
          <form
            action={updateOnboardingAction.bind(null, onboarding.id)}
            className="user-detail__action-form concierge-event-update"
          >
            <label className="user-detail__action-label">
              <span>Kickoff call (UTC)</span>
              <input
                type="datetime-local"
                name="kickoffScheduledAt"
                defaultValue={
                  onboarding.kickoffScheduledAt === null
                    ? ''
                    : toLocalInput(onboarding.kickoffScheduledAt)
                }
              />
            </label>
            <label className="user-detail__action-label">
              <span>Notes</span>
              <textarea name="notes" rows={2} defaultValue={onboarding.notes ?? ''} />
            </label>
            <button type="submit" className="user-detail__action-button">
              Save settings
            </button>
          </form>
          <form
            action={cancelOnboardingAction.bind(null, onboarding.id)}
            className="onboarding-cancel-form"
          >
            <button
              type="submit"
              className="user-detail__action-button user-detail__action-button--danger"
            >
              Cancel onboarding
            </button>
          </form>
        </section>
      )}

      {terminal && canWrite && (
        <p className="user-detail__hint">
          This onboarding is {formatLabel(onboarding.status)} — no further edits are available.
        </p>
      )}
    </>
  );
}

function StepRow({
  onboardingId,
  step,
  writable,
}: {
  readonly onboardingId: string;
  readonly step: ConciergeOnboardingStepRecord;
  readonly writable: boolean;
}): React.JSX.Element {
  return (
    <li className="onboarding-step">
      <div className="onboarding-step__head">
        <span className="onboarding-step__title">{step.title}</span>
        <span className={stepChipClass(step.status)}>{formatLabel(step.status)}</span>
      </div>
      <p className="onboarding-step__description">{step.description}</p>
      {step.completedAt !== null && (
        <p className="onboarding-step__meta">Completed {formatDateTime(step.completedAt)}</p>
      )}
      {step.notes !== null && <p className="onboarding-step__notes">{step.notes}</p>}
      {writable && (
        <form
          action={updateStepAction.bind(null, onboardingId, step.stepKey)}
          className="user-detail__action-form onboarding-step__form"
        >
          <label className="user-detail__action-label">
            <span>Status</span>
            <select name="status" defaultValue={step.status}>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="skipped">Skipped</option>
            </select>
          </label>
          <label className="user-detail__action-label">
            <span>Notes</span>
            <input name="notes" defaultValue={step.notes ?? ''} placeholder="Optional" />
          </label>
          <button type="submit" className="user-detail__action-button">
            Update step
          </button>
        </form>
      )}
    </li>
  );
}

function FactItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="concierge-detail__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function statusChipClass(status: ConciergeOnboardingDetailRecord['status']): string {
  if (status === 'completed') return 'user-row__chip user-row__chip--ok';
  if (status === 'canceled') return 'user-row__chip';
  if (status === 'in_progress') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
}

function stepChipClass(status: ConciergeOnboardingStepRecord['status']): string {
  if (status === 'completed') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

/** ISO (UTC) → `YYYY-MM-DDTHH:MM` for a datetime-local input default. */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Onboarding saved.
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
    case 'invalid-input':
      return 'The form input was invalid. Check the fields and try again.';
    case 'conflict':
      return 'That change is not allowed — the onboarding may have been canceled.';
    case 'not-found':
      return "We couldn't find that onboarding — it may have been removed.";
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The concierge service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchOnboarding(
  onboardingId: string,
): Promise<ConciergeOnboardingDetailRecord | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = GetConciergeOnboardingResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.onboarding : null;
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
