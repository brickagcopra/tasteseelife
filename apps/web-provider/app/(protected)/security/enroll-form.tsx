'use client';

import { useActionState } from 'react';

import { beginEnrollmentAction, confirmEnrollmentAction, type EnrollState } from './actions';

const INITIAL: EnrollState = { status: 'idle' };

/**
 * TOTP enrolment, as a three-step form that never loses the secret
 * (TS-309d-followup-1).
 *
 * A client component, and the reason is specific rather than habitual: the
 * enrolment secret and then the recovery codes have to survive across two
 * submissions **without being written anywhere durable**. `useActionState`
 * keeps them in the React state of one page instance, so they exist in memory
 * for as long as the customer is looking at them and nowhere else. The
 * alternatives all leak: a flash cookie is written to disk and rides every
 * later request; a query string lands in browser history, in proxy logs, and
 * in the next navigation's referer.
 *
 * The trade-off, stated plainly: enrolment does not survive a page reload
 * mid-flow. That is the correct side of the trade — an abandoned half-enrolment
 * costs the customer a retry, and `confirmedAt: null` marks it as protecting
 * nothing until finished.
 */
export function MfaEnrollForm(): React.JSX.Element {
  const [beginState, beginAction, beginPending] = useActionState(beginEnrollmentAction, INITIAL);
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmEnrollmentAction,
    beginState,
  );

  // The confirm action is seeded with the begin action's state, so once
  // confirmation has been attempted its result is the one that matters.
  const state: EnrollState = confirmState.status === 'idle' ? beginState : confirmState;

  if (state.status === 'confirmed') {
    return <RecoveryCodes codes={state.recoveryCodes} />;
  }

  return (
    <>
      {state.status === 'error' ? (
        <p className="auth-alert" role="alert">
          {errorCopy(state.code)}
        </p>
      ) : null}

      {state.status === 'started' ? (
        <div className="mfa-step">
          <h3>Step 2 — add it to your app</h3>
          <p>
            Open your authenticator app and add a new account. Most apps let you paste this setup
            key:
          </p>
          <p className="mfa-secret">
            <code>{state.secretBase32}</code>
          </p>
          <p className="mfa-hint">
            If your app scans QR codes, you can use this link instead:{' '}
            <code className="mfa-uri">{state.otpauthUrl}</code>
          </p>

          <h3>Step 3 — confirm it works</h3>
          <p>Type the six-digit code your app is showing right now.</p>
          <form action={confirmAction} className="concierge-emergency-form">
            <input type="hidden" name="methodId" value={state.methodId} />
            <label className="concierge-field">
              <span>Six-digit code</span>
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </label>
            <button type="submit" className="concierge-emergency-cta" disabled={confirmPending}>
              {confirmPending ? 'Checking…' : 'Confirm'}
            </button>
          </form>
          <p className="mfa-hint">
            If the code is rejected, check your phone&apos;s clock is set automatically — a clock
            that has drifted is the usual cause. Your setup key above still works; just try the next
            code.
          </p>
        </div>
      ) : (
        <div className="mfa-step">
          <h3>Step 1 — start</h3>
          <p>
            You&apos;ll need an authenticator app on your phone. We&apos;ll give you a setup key to
            add, then check it works before turning anything on.
          </p>
          <form action={beginAction} className="concierge-emergency-form">
            <label className="concierge-field">
              <span>Name this device (optional)</span>
              <input name="label" maxLength={64} placeholder="My phone" />
            </label>
            <button type="submit" className="concierge-emergency-cta" disabled={beginPending}>
              {beginPending ? 'Starting…' : 'Start setup'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

/**
 * The one and only render of the recovery codes.
 *
 * The server keeps hashes; there is no endpoint that returns these again. The
 * copy says so in as many words, because a reassuring "you can find these
 * later in settings" is the difference between a customer who writes them down
 * and one who is locked out after losing a phone.
 */
function RecoveryCodes({ codes }: { readonly codes: readonly string[] }): React.JSX.Element {
  return (
    <div className="mfa-step">
      <h3>You&apos;re set up. Save these recovery codes now.</h3>
      <p className="auth-alert auth-alert--info" role="status">
        <strong>This is the only time these codes are shown.</strong> We don&apos;t keep a copy we
        can read, so we can&apos;t show them to you again. Print them or write them down and keep
        them somewhere safe — away from your phone.
      </p>
      <ul className="mfa-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <p>
        Each code works once. If you lose your phone, use one to sign in — then set up your
        authenticator again on your new device.
      </p>
    </div>
  );
}

function errorCopy(code: string): string {
  switch (code) {
    case 'already-enrolled':
      return 'You already have an authenticator set up. Remove it below before adding a new one.';
    case 'invalid-input':
      return 'Please enter the six-digit code from your authenticator app.';
    case 'bad-code':
      return 'That code was not accepted. Please start the setup again.';
    default:
      return 'We could not reach the security service just now. Please try again in a moment.';
  }
}
