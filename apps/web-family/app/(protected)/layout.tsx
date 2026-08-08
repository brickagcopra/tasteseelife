import { redirect } from 'next/navigation';

import { FlashBanner } from '@/components/flash-banner';
import { HouseholdSwitcher } from '@/components/household-switcher';
import { readFlash } from '@/lib/flash';
import { readAccessToken } from '@/lib/session';

/**
 * Authenticated-area layout (TS-121).
 *
 * Belt-and-braces complement to `middleware.ts` — middleware sets the
 * first redirect line, but this server-component layout is a second
 * gate that runs on every request to a `(protected)` route. If the
 * cookie is somehow present but empty (e.g. a partial cookie write),
 * the layout still bounces to `/login`. The two layers are cheap and
 * remove an entire class of "auth bypass via middleware glitch" bugs.
 *
 * Renders `<FlashBanner />` above every protected page so server
 * actions can surface one-shot UX hints (TS-215-followup-3). The
 * server reads the cookie here so the initial paint already carries
 * the banner; the client component then clears the cookie so the
 * banner does not redisplay on refresh.
 *
 * Renders `<HouseholdSwitcher />` too (TS-505d2-followup-5a1), which
 * returns null for anyone with fewer than two households — almost
 * everyone. It lives in the layout rather than on the pages that need
 * it because the choice governs EVERY protected surface, and a control
 * that appears on some of them would leave a user changing household on
 * the dashboard to explain why the concierge page disagreed.
 */
export default async function ProtectedLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const token = await readAccessToken();
  if (token === null) redirect('/login?expired=1');

  const flash = await readFlash();

  return (
    <>
      <FlashBanner initial={flash} />
      <HouseholdSwitcher />
      {children}
    </>
  );
}
