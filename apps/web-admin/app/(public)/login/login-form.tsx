'use client';

import { useActionState } from 'react';

import { INITIAL_LOGIN_STATE, loginAction } from './actions';

/**
 * Client island for the admin login form (TS-123).
 *
 * Mirrors `apps/web-provider/app/(public)/login/login-form.tsx`. The
 * action either redirects to `/login/verify` (when service-identity
 * returns a `challenge` outcome — the expected path for admin-staff
 * because `users.mfa_enabled` is enforced at login) or back to
 * `/login?...` with the appropriate error flag. The form itself only
 * renders an inline alert when the action returns a typed error state.
 */
export function LoginForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_LOGIN_STATE);

  return (
    <form className="auth-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}
      <label htmlFor="email">
        Email
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
        />
      </label>
      <label htmlFor="password">
        Password
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <button type="submit" className="submit" disabled={pending}>
        {pending ? 'Signing you in…' : 'Continue'}
      </button>
    </form>
  );
}
