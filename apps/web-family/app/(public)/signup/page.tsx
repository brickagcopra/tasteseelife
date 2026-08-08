import Link from 'next/link';
import type { Metadata } from 'next';

import { FAMILY_TIER_OPTIONS } from '@/lib/plans';

import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Create your account — Taste & See',
};

export default function SignupPage(): React.JSX.Element {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>A warm welcome</h1>
        <p>
          Choose the rhythm that fits your family, and we&apos;ll pair you with a thoughtful
          companion or chef when you&apos;re ready.
        </p>
        <SignupForm plans={FAMILY_TIER_OPTIONS} />
        <p className="auth-foot">
          Already have an account? <Link href="/login">Sign in</Link>.
        </p>
      </div>
    </main>
  );
}
