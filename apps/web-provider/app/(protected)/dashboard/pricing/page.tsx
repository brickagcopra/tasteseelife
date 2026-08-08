import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { ProviderPricingRecordSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { PricingEditor } from './pricing-editor';

/**
 * Provider pricing-band editor page (TS-204).
 *
 * Server-component shell:
 *   1. Fetches the authenticated provider's pricing snapshot via
 *      `GET /api/v1/providers/me/pricing-snapshot` (the gateway BFF
 *      proxy added in TS-204).
 *   2. Renders an empty-state placeholder if the user has no provider
 *      row yet (pre-application).
 *   3. Renders the client-side `PricingEditor` with the loaded snapshot.
 *
 * The dashboard's "Your rate" card links here.
 */

export const metadata: Metadata = {
  title: 'Your rate — Taste & See Provider Portal',
};

const SnapshotResponseSchema = z
  .object({
    pricing: ProviderPricingRecordSchema.nullable(),
  })
  .strict();

export default async function PricingPage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/providers/me/pricing-snapshot');
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

  if (parsed.data.pricing === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Your rate lives here</h1>
          <p>
            Once your application is on file, you&apos;ll set your hourly rate in this space —
            within the range Taste &amp; See sets for your tier. Come back any time to adjust it.
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
          <h1>Your hourly rate</h1>
          <p>
            Name the rate families pay for your time. You can set it anywhere within the range we
            reserve for your tier — earn a higher certification to unlock a wider band.
          </p>
        </header>
        <PricingEditor pricing={parsed.data.pricing} />
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
          Your rate editor is briefly unreachable. Please refresh in a few seconds — and if it
          persists, our team is already on it.
        </p>
        <p>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}
