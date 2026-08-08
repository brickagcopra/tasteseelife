import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { ProviderServiceAreaRecordSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { ServiceAreasEditor } from './service-areas-editor';

/**
 * Provider self-service service-area editor page (TS-202).
 *
 * Server-component shell:
 *   1. Fetches the authenticated user's service-area snapshot via
 *      `GET /api/v1/providers/me/service-areas-snapshot` (gateway BFF
 *      proxy added in TS-202 — forwards to service-provider's GET
 *      surface).
 *   2. Renders the empty-state shell when the user has no provider row
 *      yet (they haven't completed the application).
 *   3. Otherwise renders the client-side `ServiceAreasEditor` seeded
 *      with the loaded areas (which may be an empty array — "no
 *      coverage declared yet" rather than "no provider row").
 */

export const metadata: Metadata = {
  title: 'Your coverage areas — Taste & See Provider Portal',
};

const SnapshotResponseSchema = z
  .object({
    providerId: z.string().min(1).nullable(),
    serviceAreas: z.array(ProviderServiceAreaRecordSchema).nullable(),
  })
  .strict();

export default async function ServiceAreasPage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/providers/me/service-areas-snapshot');
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

  if (parsed.data.serviceAreas === null || parsed.data.providerId === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Your coverage areas live here</h1>
          <p>
            Once your application is on file, you can tell families which neighbourhoods you travel
            to. You can come back here any time to add or adjust your coverage.
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
          <h1>Your coverage areas</h1>
          <p>
            Tell families where you travel to cook and share a meal. Coverage areas power search —
            families nearby will find you first. Changes save the moment you press{' '}
            <strong>Save coverage areas</strong>.
          </p>
        </header>
        <ServiceAreasEditor
          providerId={parsed.data.providerId}
          serviceAreas={parsed.data.serviceAreas}
        />
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
          Your coverage-area editor is briefly unreachable. Please refresh in a few seconds — and if
          it persists, our team is already on it.
        </p>
        <p>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}
