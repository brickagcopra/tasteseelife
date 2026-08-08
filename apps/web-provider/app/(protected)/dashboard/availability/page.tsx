import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { ProviderAvailabilityRecordSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { AvailabilityEditor } from './availability-editor';

/**
 * Provider self-service availability editor page (TS-203).
 *
 * Server-component shell:
 *   1. Fetches the authenticated user's availability snapshot via
 *      `GET /api/v1/providers/me/availability-snapshot` (gateway BFF
 *      proxy added in TS-203 — forwards to service-provider's GET
 *      surface).
 *   2. Renders the empty-state shell when the user has no provider
 *      row yet (they haven't completed the application).
 *   3. Otherwise renders the client-side `AvailabilityEditor` seeded
 *      with the loaded snapshot (which may itself carry empty
 *      windows + exceptions arrays — a "blank schedule" rather than
 *      a missing one).
 */

export const metadata: Metadata = {
  title: 'Your schedule — Taste & See Provider Portal',
};

const SnapshotResponseSchema = z
  .object({
    availability: ProviderAvailabilityRecordSchema.nullable(),
  })
  .strict();

export default async function AvailabilityPage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/providers/me/availability-snapshot');
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

  if (parsed.data.availability === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Your schedule lives here</h1>
          <p>
            Once your application is on file, you can declare the days and times you welcome guests.
            You can come back here any time — recurring weekly windows plus one-off blackout dates
            for vacations or personal events.
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
          <h1>Your schedule</h1>
          <p>
            Tell families when you are available to cook and share a meal. Add recurring weekly
            windows for your typical schedule, and one-off blackout dates for trips and personal
            events. Times are in your local timezone (
            <strong>{parsed.data.availability.timeZone}</strong>
            ). Changes save the moment you press <strong>Save schedule</strong>.
          </p>
        </header>
        <AvailabilityEditor availability={parsed.data.availability} />
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
          Your schedule editor is briefly unreachable. Please refresh in a few seconds — and if it
          persists, our team is already on it.
        </p>
        <p>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}
