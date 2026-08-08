import Link from 'next/link';
import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in — Taste & See',
};

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const justSignedUp = params['signed_up'] === '1';
  const expired = params['expired'] === '1';

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Welcome back</h1>
        <p>Sign in to manage your loved one&apos;s visits, billing, and wellness updates.</p>

        {justSignedUp ? (
          <div className="auth-alert auth-alert--info" role="status">
            Your account is ready. Sign in to continue.
          </div>
        ) : null}
        {expired ? (
          <div className="auth-alert" role="status">
            Your session has expired. Please sign in again.
          </div>
        ) : null}

        <LoginForm />

        <p className="auth-foot">
          New to Taste &amp; See? <Link href="/signup">Create an account</Link>.
        </p>
      </div>
    </main>
  );
}
