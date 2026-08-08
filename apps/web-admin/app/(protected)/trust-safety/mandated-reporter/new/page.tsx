import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MandatedReporterJurisdictionListResponseSchema,
  MeResponseSchema,
  US_JURISDICTION_CODES,
  type MandatedReporterJurisdictionRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readDetailParam } from '@/lib/problem-detail';

import { openCaseAction } from '../actions';

export const metadata: Metadata = {
  title: 'Open a mandated-reporter case — Taste & See Admin',
};

/**
 * Open a mandated-reporter case (TS-303c2b).
 *
 * **Opening a case IS the determination.** There is no "suspected abuse" flag
 * on an incident and nothing derives one from category or severity — that was
 * settled in TS-303a, because auto-routing would manufacture statutory
 * filings against families who reported a missed meal. Submitting this form is
 * a trained operator's legal judgement, and the copy says so.
 *
 * **Reached from the incident, normally.** The incident detail page links
 * here with `?incidentId=` pre-filled (TS-303c2b-followup-2), which is the
 * path that makes sense: you decide an incident may be reportable while
 * looking at it. The field stays editable for the case where an operator
 * carries an id in from elsewhere.
 *
 * The state list shows which jurisdictions are verified, because that decides
 * whether the case can reach filing prep at all. It does NOT block the choice:
 * a case must be openable in an unverified state, since the platform's own
 * compliance backlog must never stop the statutory clock (TS-303a).
 */

export default async function OpenMandatedReporterCasePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const error = readError(search);
  const prefilledIncidentId = readIncidentId(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
        </main>
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'trust_safety:write')) redirect('/dashboard/no-access');

  const jurisdictions = await fetchJurisdictions();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — mandated reporter</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/trust-safety/mandated-reporter" className="dash-logout">
            Back to queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Open a mandated-reporter case</h1>
        <p>
          Opening a case is the determination that an incident may be a reportable case of abuse or
          neglect. Nothing else in the platform makes that call — it is not derived from a category,
          a severity, or a keyword. Once opened, the statutory clock runs and the incident cannot be
          closed until a second operator signs off.
        </p>

        {error !== null && (
          <p className="auth-alert" role="alert">
            {error}
          </p>
        )}

        <section className="user-detail__section">
          <form action={openCaseAction} className="user-detail__action-form">
            <label className="user-detail__action-label">
              <span>Incident id</span>
              <input
                type="text"
                name="incidentId"
                required
                defaultValue={prefilledIncidentId ?? ''}
              />
            </label>
            <p className="user-detail__hint">
              {prefilledIncidentId === null ? (
                <>
                  Pick the incident from the{' '}
                  <Link href="/trust-safety/incidents">incident queue</Link> and open a case from
                  its detail page, or paste an id here.
                </>
              ) : (
                <>
                  Carried over from{' '}
                  <Link href={`/trust-safety/incidents/${encodeURIComponent(prefilledIncidentId)}`}>
                    the incident
                  </Link>
                  .
                </>
              )}
            </p>

            <label className="user-detail__action-label">
              <span>State whose law governs</span>
              <select name="stateCode" required defaultValue="">
                <option value="" disabled>
                  Select a state…
                </option>
                {US_JURISDICTION_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                    {jurisdictionSuffix(jurisdictions, code)}
                  </option>
                ))}
              </select>
            </label>
            <p className="user-detail__hint">
              The senior&apos;s state of residence. An unverified state can still take a case — our
              compliance backlog must not stop the clock — but it cannot reach filing prep until
              compliance attests to that state&apos;s kit.
              {jurisdictions === null && ' (Kit status is unavailable right now.)'}
            </p>

            <label className="user-detail__action-label">
              <span>Opening determination (optional)</span>
              <textarea name="determinationNotes" rows={4} />
            </label>
            <p className="user-detail__hint">
              Confidential. Concerns a named senior — recorded on the case, never on an event or a
              log line.
            </p>

            <button type="submit" className="user-detail__action-button">
              Open case
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

/**
 * `— verified` / `— kit unverified` / `— no kit` next to a state code.
 * Advisory only: the choice is never blocked (see the page doc-block).
 */
function jurisdictionSuffix(
  jurisdictions: readonly MandatedReporterJurisdictionRecord[] | null,
  code: string,
): string {
  if (jurisdictions === null) return '';
  const row = jurisdictions.find((j) => j.stateCode === code);
  if (row === undefined) return ' — no kit yet';
  return row.verified ? ' — verified' : ' — kit unverified';
}

function readIncidentId(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  const raw = search['incidentId'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readError(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  if (search['action'] !== 'err') return null;
  const detail = readDetailParam(search);
  if (detail !== null) return detail;
  const code = search['code'];
  if (code === 'invalid-input') {
    return 'Check the incident id and state code, then try again.';
  }
  return 'We couldn’t open the case. The trust & safety service may be unreachable.';
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchJurisdictions(): Promise<readonly MandatedReporterJurisdictionRecord[] | null> {
  const result = await callGateway<unknown>(
    '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions',
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MandatedReporterJurisdictionListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.jurisdictions : null;
}
