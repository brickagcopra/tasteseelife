import { selectHouseholdAction } from '@/app/(protected)/household-actions';
import { fetchMe } from '@/lib/me-api';
import { readSelectedHouseholdId } from '@/lib/session';

/**
 * Household switcher (TS-505d2-followup-5a1).
 *
 * **Why this exists.** The gateway resolves a request's household tenant
 * scope from the caller's active memberships and auto-resolves it when there
 * is exactly one. A member of two households — the adult child paying for two
 * parents, a shape the platform explicitly supports — is deliberately left
 * unscoped until the client names one, because picking one silently would act
 * on the wrong parent's household. Without this control that person met a
 * refusal on every family surface: the visits dashboard, wellness trends and
 * anomalies, every concierge surface, and reporting a concern.
 *
 * **It renders nothing for anyone with fewer than two households**, which is
 * almost everyone. A picker with one option is a question with one answer —
 * it would only make the common case look more complicated than it is.
 *
 * A plain server-rendered `<form>` with a submit button rather than an
 * on-change client component: it works without JavaScript, it is one tab stop
 * and one activation for a keyboard or switch user, and it needs no hydration
 * on a control most people never see. Switching household changes what every
 * page shows, so an explicit confirm is also the honest interaction —
 * `onChange` navigation would move a senior's care record out from under
 * someone who was only browsing the list.
 */
export async function HouseholdSwitcher(): Promise<React.JSX.Element | null> {
  const me = await fetchMe();
  if (me.kind !== 'ok') return null;

  const households = me.me.households;
  if (households.length < 2) return null;

  const selected = await readSelectedHouseholdId();
  // `tenantScope` is what the gateway actually acted on for THIS request —
  // preferred over the cookie, so a choice the gateway has since rejected
  // (a membership removed under us) does not render as still active.
  const active = me.me.tenantScope.type === 'household' ? me.me.tenantScope.householdId : selected;

  return (
    <form action={selectHouseholdAction} className="household-switcher">
      <label className="household-switcher-label" htmlFor="household-switcher-select">
        Household you are viewing
      </label>
      <select
        id="household-switcher-select"
        name="householdId"
        className="household-switcher-select"
        defaultValue={active ?? ''}
      >
        {active === null && (
          // The unchosen state is a real one and it is named, rather than the
          // browser silently showing the first option as though it were the
          // answer. Someone arriving here has been refused by a page and
          // needs to understand what to do.
          <option value="" disabled>
            Choose a household…
          </option>
        )}
        {households.map((membership) => (
          <option key={membership.householdId} value={membership.householdId}>
            {householdLabel(membership.householdId, membership.memberRole)}
          </option>
        ))}
      </select>
      <button type="submit" className="household-switcher-submit">
        View
      </button>
    </form>
  );
}

/**
 * What to call a household in the list.
 *
 * **There is no name to show.** The membership list carries household ids and
 * member roles and nothing else — deliberately, because it is consumed by an
 * authorisation decision and a hot-path internal route is the last place to
 * widen a projection. So the label is the role plus a short, stable reference,
 * which is enough to tell two households apart and never invents a name the
 * platform does not hold.
 *
 * A friendlier label (the senior's name, which is what a family would
 * recognise) needs a household-facing read the portal does not have and a
 * consent question §12 would want asked first. Recorded rather than guessed.
 */
function householdLabel(householdId: string, memberRole: string): string {
  const role = ROLE_LABELS[memberRole] ?? 'Member';
  return `${role} — ${householdId.slice(-6)}`;
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  primary_payer: 'You manage this household',
  family_observer: 'You follow this household',
  senior_user: 'Your own household',
};
