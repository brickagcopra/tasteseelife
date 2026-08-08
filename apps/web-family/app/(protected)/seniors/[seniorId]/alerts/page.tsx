import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { SeniorAlertPreferencesResponse, SeniorAlertType } from '@taste-and-see/contracts';

import { getSeniorAlertPreferences } from '@/lib/senior-alert-preferences-api';
import { getSeniorConsent } from '@/lib/senior-consent-api';
import { listMySeniors } from '@/lib/seniors-api';

import { saveSeniorAlertsAction } from './actions';

export const metadata: Metadata = {
  title: 'Alert settings — Taste & See',
};

/**
 * Per-senior alert-subscription editor (TS-234).
 *
 * Each household member — the primary payer *and* every family observer —
 * chooses which alerts they personally want about a loved one. Three
 * toggles; defaults are operational + safety on (missed visit, emergency),
 * observation-derived off (PRD §6.4). Unlike the sharing-settings editor
 * (TS-238), there is no manager gate — every member manages their own
 * subscription, so the form is always editable for an active member.
 *
 * The concerning-observation alert draws on visit wellness notes, so it
 * reaches family observers only when the senior has shared their notes.
 * We surface that as a transparency hint (read from the consent map) — not
 * a hard gate: the actual delivery check lives downstream in the alert
 * dispatcher (a TS-234 follow-up), and the account holder sees observation
 * alerts regardless.
 *
 * Auth + reachability: `getSeniorAlertPreferences` is the row-level gate —
 * a non-member gets 403 (rendered as "we couldn't find that loved one" so
 * foreign senior ids can't be probed).
 */

interface AlertCopy {
  readonly type: SeniorAlertType;
  readonly label: string;
  readonly helper: string;
}

const ALERTS: readonly AlertCopy[] = [
  {
    type: 'missedVisit',
    label: 'Missed visits',
    helper: "Let me know if a scheduled visit doesn't happen — a provider no-show or a gap.",
  },
  {
    type: 'concerningObservation',
    label: 'Concerning changes',
    helper:
      'A gentle heads-up if visit notes show a worrying pattern — for example, appetite trailing off across a few visits.',
  },
  {
    type: 'emergencyFlag',
    label: 'Emergencies',
    helper: 'Tell me right away if an emergency or welfare concern is raised during a visit.',
  },
];

export default async function SeniorAlertsPage({
  params,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;

  const [preferencesResult, consentResult, seniorsResult] = await Promise.all([
    getSeniorAlertPreferences(seniorId),
    getSeniorConsent(seniorId),
    listMySeniors(),
  ]);

  if (preferencesResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (preferencesResult.kind === 'forbidden' || preferencesResult.kind === 'not_found') {
    return (
      <Shell>
        <h1>We couldn&apos;t find that loved one</h1>
        <p className="providers-empty">
          This profile isn&apos;t in your household, or it may have been removed.{' '}
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (preferencesResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load these alert settings right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const preferences = preferencesResult.preferences;
  const senior =
    seniorsResult.kind === 'ok'
      ? seniorsResult.seniors.find((s) => s.seniorId === seniorId)
      : undefined;
  const name =
    senior !== undefined
      ? senior.displayName !== null && senior.displayName.length > 0
        ? senior.displayName
        : senior.firstName
      : 'your loved one';

  // Transparency hint only — never a hard gate. We know notes aren't shared
  // only when the consent read succeeds and reports `notes: false`.
  const notesShared = consentResult.kind === 'ok' ? consentResult.consent.notes : true;

  return (
    <Shell>
      <h1>How we keep you posted about {name}</h1>
      <p>
        Choose which alerts you&apos;d like to receive. These are your own choices — every family
        member sets their own. We&apos;ll reach you through the channels in your notification
        settings.
      </p>

      <AlertsEditor
        seniorId={seniorId}
        preferences={preferences}
        name={name}
        notesShared={notesShared}
      />

      <p>
        <Link href={`/seniors/${encodeURIComponent(seniorId)}/sharing`} className="link-inline">
          Sharing settings
        </Link>
      </p>
    </Shell>
  );
}

function AlertsEditor({
  seniorId,
  preferences,
  name,
  notesShared,
}: {
  readonly seniorId: string;
  readonly preferences: SeniorAlertPreferencesResponse;
  readonly name: string;
  readonly notesShared: boolean;
}): React.JSX.Element {
  return (
    <form action={saveSeniorAlertsAction.bind(null, seniorId)} className="sharing-form">
      <fieldset className="sharing-fieldset">
        <legend className="sharing-fieldset__legend">Choose your alerts</legend>
        {ALERTS.map((item) => (
          <div key={item.type} className="sharing-row">
            <input
              type="checkbox"
              id={`alert-${item.type}`}
              name={item.type}
              className="sharing-row__toggle"
              defaultChecked={preferences[item.type]}
            />
            <label htmlFor={`alert-${item.type}`} className="sharing-row__label">
              <span className="sharing-row__title">{item.label}</span>
              <span className="sharing-row__helper">
                {item.helper}
                {item.type === 'concerningObservation' && !notesShared ? (
                  <>
                    {' '}
                    <span className="sharing-row__note">
                      {name}&apos;s visit notes aren&apos;t shared with family observers yet, so
                      this alert may not reach everyone until they&apos;re turned on in Sharing
                      settings.
                    </span>
                  </>
                ) : null}
              </span>
            </label>
          </div>
        ))}
      </fieldset>
      <div className="sharing-actions">
        <button type="submit" className="plans-cta">
          Save alert settings
        </button>
        <Link href="/seniors" className="link-inline">
          Back to your loved ones
        </Link>
      </div>
    </form>
  );
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/seniors" className="dash-logout">
          Your loved ones
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
