import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { SeniorConsentResponse, SeniorConsentSurface } from '@taste-and-see/contracts';

import { getSeniorConsent } from '@/lib/senior-consent-api';
import { listMySeniors } from '@/lib/seniors-api';

import { saveSeniorConsentAction } from './actions';

export const metadata: Metadata = {
  title: 'Sharing settings — Taste & See',
};

/**
 * Senior sharing-settings editor (TS-238).
 *
 * Lets the senior — or the primary payer acting as account manager —
 * choose which surfaces family observers may see. Four toggles, default
 * opt-out (CLAUDE.md §12 — "Senior consent gates ... the default is
 * opt-out"). The primary payer + senior always see everything they
 * manage; these toggles tune what the *observer* members see.
 *
 * Capability: the consent read returns `canManage` (true for the primary
 * payer + senior end-user). A managing caller sees the editable form; a
 * family observer sees a read-only summary of the current choices and a
 * note that only the account holder or the senior can change them. The
 * `PUT` re-checks server-side regardless — `canManage` is only a UI hint.
 *
 * Auth + reachability: `getSeniorConsent` is the row-level gate — a
 * non-member gets 403 (rendered as "we couldn't find that loved one" so
 * foreign senior ids can't be probed).
 */

interface SurfaceCopy {
  readonly surface: SeniorConsentSurface;
  readonly label: string;
  readonly helper: string;
}

const SURFACES: readonly SurfaceCopy[] = [
  {
    surface: 'health',
    label: 'Health details',
    helper:
      'Date of birth, any memory or dementia notes, and medical context. Off by default — turn on only if you want family observers to see this.',
  },
  {
    surface: 'notes',
    label: 'Visit notes',
    helper:
      'The warm notes from each visit — spirits, appetite, the rhythm of the day. Shared with family observers when on.',
  },
  {
    surface: 'photos',
    label: 'Photos from visits',
    helper: 'Photos shared during a visit, so family can see the moments they missed.',
  },
  {
    surface: 'location',
    label: 'Location during visits',
    helper: 'Where a visit took place (check-in and check-out). Off by default.',
  },
];

export default async function SeniorSharingPage({
  params,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;

  const [consentResult, seniorsResult] = await Promise.all([
    getSeniorConsent(seniorId),
    listMySeniors(),
  ]);

  if (consentResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (consentResult.kind === 'forbidden' || consentResult.kind === 'not_found') {
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

  if (consentResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load these sharing settings right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const consent = consentResult.consent;
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

  return (
    <Shell>
      <h1>What {name} shares with family</h1>
      <p>
        These choices control what family members who follow along — beyond the main account holder
        — can see. Everything is private by default; turn on only what {name} is comfortable
        sharing. The account holder always sees everything they manage.
      </p>

      {consent.canManage ? (
        <ConsentEditor seniorId={seniorId} consent={consent} />
      ) : (
        <ConsentReadOnly consent={consent} />
      )}

      <p>
        <Link href={`/seniors/${encodeURIComponent(seniorId)}/photos`} className="link-inline">
          See the photo gallery
        </Link>
        {' · '}
        <Link href={`/seniors/${encodeURIComponent(seniorId)}/alerts`} className="link-inline">
          Alert settings
        </Link>
      </p>
    </Shell>
  );
}

function ConsentEditor({
  seniorId,
  consent,
}: {
  readonly seniorId: string;
  readonly consent: SeniorConsentResponse;
}): React.JSX.Element {
  return (
    <form action={saveSeniorConsentAction.bind(null, seniorId)} className="sharing-form">
      <fieldset className="sharing-fieldset">
        <legend className="sharing-fieldset__legend">Choose what to share</legend>
        {SURFACES.map((item) => (
          <div key={item.surface} className="sharing-row">
            <input
              type="checkbox"
              id={`consent-${item.surface}`}
              name={item.surface}
              className="sharing-row__toggle"
              defaultChecked={consent[item.surface]}
            />
            <label htmlFor={`consent-${item.surface}`} className="sharing-row__label">
              <span className="sharing-row__title">{item.label}</span>
              <span className="sharing-row__helper">{item.helper}</span>
            </label>
          </div>
        ))}
      </fieldset>
      <div className="sharing-actions">
        <button type="submit" className="plans-cta">
          Save sharing settings
        </button>
        <Link href="/seniors" className="link-inline">
          Back to your loved ones
        </Link>
      </div>
    </form>
  );
}

function ConsentReadOnly({
  consent,
}: {
  readonly consent: SeniorConsentResponse;
}): React.JSX.Element {
  return (
    <>
      <ul className="sharing-summary">
        {SURFACES.map((item) => (
          <li key={item.surface} className="sharing-summary__row">
            <span className="sharing-summary__title">{item.label}</span>
            <span
              className="sharing-summary__state"
              data-shared={consent[item.surface] ? 'yes' : 'no'}
            >
              {consent[item.surface] ? 'Shared with you' : 'Not shared'}
            </span>
          </li>
        ))}
      </ul>
      <p className="providers-empty">
        Only the main account holder or your loved one can change these settings. If something
        should be shared with you, ask the account holder to update it.
      </p>
      <p>
        <Link href="/seniors" className="link-inline">
          Back to your loved ones
        </Link>
      </p>
    </>
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
