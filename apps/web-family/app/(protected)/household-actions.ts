'use server';

import { revalidatePath } from 'next/cache';

import { fetchMe } from '@/lib/me-api';
import { clearSelectedHouseholdId, writeSelectedHouseholdId } from '@/lib/session';

/**
 * Choose which household this session is acting in (TS-505d2-followup-5a1).
 *
 * Writes the portal's `tas_family_household` cookie, which `callGateway`
 * attaches to every authenticated request as `X-Household-Id`. The gateway
 * validates it against the caller's own active memberships and answers 403 on
 * one they do not hold — so this action does not have to be the security
 * boundary, and it is not written as though it were.
 *
 * **It still checks membership before writing, for a different reason.**
 * Writing a household this user cannot act in would leave every subsequent
 * page 403ing with no obvious way back — a self-inflicted lockout from a
 * stale tab or a membership removed between render and submit. Checking here
 * turns that into a no-op plus a cleared cookie, which lands the user back at
 * the pick-one state the switcher renders.
 *
 * `revalidatePath('/', 'layout')` because the choice changes what every
 * protected page shows; anything narrower leaves a cached dashboard for the
 * other household on screen.
 */
export async function selectHouseholdAction(formData: FormData): Promise<void> {
  const raw = formData.get('householdId');
  if (typeof raw !== 'string' || raw.trim().length === 0) return;
  const householdId = raw.trim();

  const me = await fetchMe();
  if (me.kind !== 'ok') return;

  const holdsIt = me.me.households.some((membership) => membership.householdId === householdId);
  if (!holdsIt) {
    // Not an error page: the honest outcome is "that is no longer one of
    // yours", and the switcher's unchosen state says so better than a stack
    // of problem-details would.
    await clearSelectedHouseholdId();
    revalidatePath('/', 'layout');
    return;
  }

  await writeSelectedHouseholdId(householdId);
  revalidatePath('/', 'layout');
}
