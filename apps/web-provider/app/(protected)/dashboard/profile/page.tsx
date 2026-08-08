import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { ProviderProfileRecordSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { ProfileEditor } from './profile-editor';

/**
 * Provider self-service profile editor page (TS-200).
 *
 * Server-component shell:
 *   1. Fetches the authenticated user's profile snapshot via
 *      `GET /api/v1/providers/me/profile-snapshot` (the gateway BFF
 *      proxy added in TS-200 — forwards to service-provider's GET
 *      surface).
 *   2. Redirects to /dashboard with a helpful banner if the user
 *      has no provider row yet (they haven't completed the
 *      application). Once TS-051 routes ship a richer "your
 *      application is in review" UX, the redirect target updates.
 *   3. Renders the client-side `ProfileEditor` with the loaded
 *      snapshot.
 *
 * Senior-mode + accessibility — every section heading is in the
 * shared `auth-shell` / `dash-shell` typography scale; tap targets
 * meet WCAG 2.2 AA minimums via the design-tokens shared package.
 *
 * The dashboard's "Your profile" placeholder card (TS-122) links
 * here.
 */

export const metadata: Metadata = {
  title: 'Your profile — Taste & See Provider Portal',
};

const SnapshotResponseSchema = z
  .object({
    profile: ProviderProfileRecordSchema.nullable(),
  })
  .strict();

export default async function ProfilePage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/providers/me/profile-snapshot');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    return <UnavailableShell />;
  }

  const parsed = SnapshotResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return <UnavailableShell />;
  }

  if (parsed.data.profile === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Your profile lives here</h1>
          <p>
            Once your application is on file, your profile editor will appear in this space. You can
            come back here any time — bio, languages, cuisines, and the specialties you bring to the
            table.
          </p>
          <p>
            <a href="/dashboard">← Back to your dashboard</a>
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="dash-shell">
      <main className="dash-main">
        <header className="profile-header">
          <h1>Your profile</h1>
          <p>
            Tell families about your cooking, the languages you speak, the cuisines you love, and
            the dietary specialties you bring. Changes save the moment you press{' '}
            <strong>Save profile</strong>.
          </p>
        </header>
        <ProfileEditor profile={parsed.data.profile} />
        <p style={{ marginTop: 24 }}>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}

function UnavailableShell(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>We&apos;re having a moment</h1>
        <p>
          Your profile editor is briefly unreachable. Please refresh in a few seconds — and if it
          persists, our team is already on it.
        </p>
        <p>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}
