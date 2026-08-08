'use client';

import { useActionState } from 'react';

import { INITIAL_LOGIN_STATE, loginAction } from './actions';

/**
 * Client island for the login form (TS-121).
 *
 * Lives in its own client component so the parent page stays a server
 * component. Uses React 19's `useActionState` to wire the server action
 * + render the typed `LoginActionState` inline. The form itself has no
 * client-side JavaScript fallback beyond `useActionState`'s pending
 * flag — the browser does a full POST via the form's native submit if
 * JS fails to hydrate.
 */
export function LoginForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_LOGIN_STATE);

  return (
    <form className="auth-form" action={formAction}>
      {state.status !== 'idle' && state.message !== undefined ? (
        <div
          className={state.status === 'mfa_required' ? 'auth-alert auth-alert--info' : 'auth-alert'}
          role="alert"
        >
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
        {pending ? 'Signing you in…' : 'Sign in'}
      </button>
    </form>
  );
}
