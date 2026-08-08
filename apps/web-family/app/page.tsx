import { redirect } from 'next/navigation';

import { readAccessToken } from '@/lib/session';

/**
 * Family-portal root (TS-121).
 *
 * Redirects authenticated visitors to the dashboard and anonymous
 * visitors to the login page. The portal has no public landing
 * surface of its own — that's `apps/web-marketing`.
 */
export default async function RootPage(): Promise<void> {
  const token = await readAccessToken();
  redirect(token === null ? '/login' : '/dashboard');
}
