import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in — Taste & See Admin Console',
};

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const expired = params['expired'] === '1';
  const noAdminRole = params['no_admin_role'] === '1';
  const mfaRequired = params['mfa_required'] === '1';
  const ssoRequired = params['sso_required'] === '1';
  const verifyFailed = params['verify_failed'] === '1';

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Admin sign-in</h1>
        <p>
          Operations console for Taste &amp; See staff. Sign in with your work email — you&apos;ll
          complete a second factor before reaching any operational surface.
        </p>

        {expired ? (
          <div className="auth-alert" role="status">
            Your session has expired. Please sign in again.
          </div>
        ) : null}
        {noAdminRole ? (
          <div className="auth-alert" role="alert">
            This account does not have a staff role assigned. Reach out to a super_admin to be
            granted access.
          </div>
        ) : null}
        {mfaRequired ? (
          <div className="auth-alert auth-alert--info" role="status">
            Your account requires multi-factor sign-in. Please complete enrollment with a
            super_admin before continuing.
          </div>
        ) : null}
        {ssoRequired ? (
          <div className="auth-alert auth-alert--info" role="status">
            Your organization signs in through single sign-on, which isn&apos;t available here just
            yet. Please reach out to your administrator for a hand getting in.
          </div>
        ) : null}
        {verifyFailed ? (
          <div className="auth-alert" role="alert">
            That code didn&apos;t match. Please sign in again to receive a fresh challenge.
          </div>
        ) : null}

        <LoginForm />
      </div>
    </main>
  );
}
