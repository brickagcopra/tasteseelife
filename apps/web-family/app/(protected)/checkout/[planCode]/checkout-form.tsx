'use client';

import { useActionState, useState } from 'react';

import { INITIAL_CHECKOUT_STATE, checkoutAction } from './actions';

interface CheckoutFormProps {
  readonly planCode: string;
  readonly planName: string;
  readonly customerId: string;
  readonly monthlyLabel: string;
  readonly annualLabel: string;
}

/**
 * Client island for the checkout confirm page (TS-124).
 *
 * Renders the monthly/annual interval picker + the "Continue" submit
 * button. Submission flows through the parent `checkoutAction` server
 * action which creates a Stripe Checkout Session and redirects to the
 * hosted URL.
 *
 * The form is intentionally tiny — Stripe collects the rest (card,
 * billing address, email confirmation) on the hosted page. This keeps
 * PCI surface area off our origin entirely (CLAUDE.md §3.5).
 */
export function CheckoutForm({
  planCode,
  planName,
  customerId,
  monthlyLabel,
  annualLabel,
}: CheckoutFormProps): React.JSX.Element {
  const [state, formAction, pending] = useActionState(checkoutAction, INITIAL_CHECKOUT_STATE);
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');

  return (
    <form className="checkout-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}

      <input type="hidden" name="planCode" value={planCode} />
      <input type="hidden" name="customerId" value={customerId} />

      <label htmlFor="checkout-email">
        Email for receipts
        <input
          id="checkout-email"
          name="customerEmail"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
        />
        <span className="help">
          We&apos;ll send Stripe receipts here and use it for billing reminders.
        </span>
      </label>

      <fieldset className="interval-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Billing rhythm for {planName}</legend>
        <label
          className={`interval-card${billingInterval === 'monthly' ? ' selected' : ''}`}
          htmlFor="interval-monthly"
        >
          <input
            id="interval-monthly"
            type="radio"
            name="billingInterval"
            value="monthly"
            checked={billingInterval === 'monthly'}
            onChange={() => setBillingInterval('monthly')}
          />
          <span className="interval-title">Monthly</span>
          <span className="interval-price">{monthlyLabel}</span>
          <span className="interval-detail">Flexible — pause or change tier any month.</span>
        </label>
        <label
          className={`interval-card${billingInterval === 'annual' ? ' selected' : ''}`}
          htmlFor="interval-annual"
        >
          <input
            id="interval-annual"
            type="radio"
            name="billingInterval"
            value="annual"
            checked={billingInterval === 'annual'}
            onChange={() => setBillingInterval('annual')}
          />
          <span className="interval-title">Annual</span>
          <span className="interval-price">{annualLabel}</span>
          <span className="interval-detail">Best value — two months on us when paid yearly.</span>
        </label>
      </fieldset>

      <button type="submit" className="submit" disabled={pending}>
        {pending ? 'Opening secure checkout…' : 'Continue to secure payment'}
      </button>
    </form>
  );
}
