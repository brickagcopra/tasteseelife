'use client';

import { useActionState } from 'react';

import { INITIAL_VERIFY_STATE, verifyAction } from './actions';

/**
 * Client island for the MFA-verify form (TS-123).
 *
 * Renders a numeric 6-digit code input. The form action posts to the
 * server-side `verifyAction` which consumes the MFA-challenge cookie,
 * forwards to the gateway, writes the session cookies on success, and
 * redirects to `/dashboard`. Wrong code surfaces inline; expired or
 * missing challenge bounces back to `/login`.
 */
export function VerifyForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState(verifyAction, INITIAL_VERIFY_STATE);

  return (
    <form className="auth-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}
      <label htmlFor="code">
        Verification code
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          minLength={6}
          pattern="\d{6}"
          required
        />
      </label>
      <button type="submit" className="submit" disabled={pending}>
        {pending ? 'Verifying…' : 'Verify'}
      </button>
    </form>
  );
}
