import { redirect } from 'next/navigation';

import { readAccessToken } from '@/lib/session';

/**
 * Authenticated-area layout (TS-122).
 *
 * Mirrors `apps/web-family/app/(protected)/layout.tsx`. Belt-and-braces
 * complement to `middleware.ts` — middleware sets the first redirect
 * line, but this server-component layout is a second gate that runs on
 * every request to a `(protected)` route. If the cookie is somehow
 * present but empty (e.g. a partial cookie write), the layout still
 * bounces to `/login`. The two layers are cheap and remove an entire
 * class of "auth bypass via middleware glitch" bugs.
 */
export default async function ProtectedLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const token = await readAccessToken();
  if (token === null) redirect('/login?expired=1');

  return <>{children}</>;
}
