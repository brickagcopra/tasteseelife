import Link from 'next/link';
import type { Metadata } from 'next';

import { PROVIDER_TIER_OPTIONS } from '@/lib/tiers';

import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Apply to be a provider — Taste & See',
};

export default function SignupPage(): React.JSX.Element {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Cook with purpose</h1>
        <p>
          Build a sustainable career around meaningful hospitality work — recurring clients, a
          training pathway, and clients who genuinely look forward to your visits. Start by choosing
          the tier that fits you today; you can always move up.
        </p>
        <SignupForm tiers={PROVIDER_TIER_OPTIONS} />
        <p className="auth-foot">
          Already applied? <Link href="/login">Sign in</Link>.
        </p>
      </div>
    </main>
  );
}
