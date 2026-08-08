import type { Metadata } from 'next';
import { Cormorant_Garamond, DM_Sans } from 'next/font/google';

import './globals.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-dm-sans',
  display: 'swap',
});

/**
 * The admin console is an authenticated application: every page reads the
 * session cookie and calls the gateway on behalf of one signed-in staff user. There
 * is nothing here to statically generate, and **attempting to is what broke the
 * build** (TS-505c-followup-1).
 *
 * `readAccessToken()` calls `loadEnv()` before `cookies()`. During static
 * generation that ordering matters enormously: `cookies()` is the signal Next
 * uses to discover a route is dynamic and bail out of prerendering, but the env
 * read throws first — so `next build` failed with `API_GATEWAY_BASE_URL:
 * Required` instead of quietly marking the route dynamic.
 * `API_GATEWAY_BASE_URL` is a **runtime** value (one image, many environments,
 * supplied by the k8s ConfigMap), so there was never a correct value to give the
 * build; the fix is to not prerender.
 *
 * Declared once, here, rather than on each page. It was previously declared per
 * page and **34 of 111 pages across the three portals had been missed** — a
 * property that is true of the whole app should not depend on remembering it 111
 * times. A segment that genuinely wants caching can still override.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Taste & See — Admin Console',
  description:
    'Operational console for Taste & See staff: user management, subscriptions, bookings, accounting, trust & safety.',
  /**
   * The admin console is authenticated, MFA-gated, and never indexable.
   * Robots header layers over the production WAF rules as defence-in-
   * depth (CLAUDE.md §3.2).
   */
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className={`${cormorant.variable} ${dmSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
