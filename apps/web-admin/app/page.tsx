import { redirect } from 'next/navigation';

import { readAccessToken } from '@/lib/session';

/**
 * Admin-console root (TS-123).
 *
 * Redirects authenticated visitors to the dashboard and anonymous
 * visitors to the login page. The console has no public landing
 * surface — operators arrive via the deep link from the activity
 * monitoring inbox / the password-reset email / their browser
 * bookmark.
 */
export default async function RootPage(): Promise<void> {
  const token = await readAccessToken();
  redirect(token === null ? '/login' : '/dashboard');
}
