import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { SENIOR_PREFERENCE_VALUE_MAX_LENGTH } from '@taste-and-see/contracts';

import { SENIOR_PREFERENCE_SECTIONS } from '@/lib/senior-preference-fields';
import { getSeniorPreferences, listMySeniors } from '@/lib/seniors-api';

import { saveSeniorPreferencesAction } from './actions';

export const metadata: Metadata = {
  title: 'Preferences — Taste & See',
};

/**
 * Senior preference editor (TS-214).
 *
 * A guided view of the open `senior_preferences` key/value store: the
 * curated catalog in `lib/senior-preference-fields` rendered as four
 * warm sections (food & dietary, culture & traditions, language &
 * communication, companionship & comfort). Each field's textarea is
 * pre-filled from the senior's current profile; the save action diffs
 * against current and bulk-merge-upserts only what changed.
 *
 * Auth + reachability: `getSeniorPreferences` is the row-level gate —
 * a non-member gets 403 (rendered as "we couldn't find that loved one"
 * so foreign senior ids can't be probed). The senior's name comes from
 * the `/me/seniors` directory in the same request cycle.
 */
export default async function SeniorPreferencesPage({
  params,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;

  const [prefsResult, seniorsResult] = await Promise.all([
    getSeniorPreferences(seniorId),
    listMySeniors(),
  ]);

  if (prefsResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (prefsResult.kind === 'forbidden' || prefsResult.kind === 'not_found') {
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

  if (prefsResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load these preferences right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

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

  const valueByKey = new Map(prefsResult.preferences.map((p) => [p.key, p.value]));

  return (
    <Shell>
      <h1>{name}&apos;s preferences</h1>
      <p>
        Anything you share helps our chefs cook and keep company in a way that feels personal. Leave
        a field blank if it doesn&apos;t apply — you can come back and add more any time.
      </p>

      <form action={saveSeniorPreferencesAction.bind(null, seniorId)} className="prefs-form">
        {SENIOR_PREFERENCE_SECTIONS.map((section) => (
          <fieldset key={section.id} className="prefs-section">
            <legend className="prefs-section__legend">{section.title}</legend>
            <p className="prefs-section__desc">{section.description}</p>
            {section.fields.map((field) => (
              <div key={field.key} className="prefs-field">
                <label htmlFor={field.key} className="prefs-field__label">
                  {field.label}
                </label>
                <span id={`${field.key}-helper`} className="prefs-field__helper">
                  {field.helper}
                </span>
                <textarea
                  id={field.key}
                  name={field.key}
                  className="prefs-field__input"
                  rows={2}
                  maxLength={SENIOR_PREFERENCE_VALUE_MAX_LENGTH}
                  placeholder={field.placeholder}
                  aria-describedby={`${field.key}-helper`}
                  defaultValue={valueByKey.get(field.key) ?? ''}
                />
              </div>
            ))}
          </fieldset>
        ))}

        <div className="prefs-actions">
          <button type="submit" className="plans-cta">
            Save preferences
          </button>
          <Link
            href={`/seniors/${encodeURIComponent(seniorId)}/recommendations`}
            className="link-inline"
          >
            See recommended chefs
          </Link>
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
        </div>
      </form>
    </Shell>
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
