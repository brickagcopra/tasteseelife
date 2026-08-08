'use client';

import { useActionState, useState } from 'react';

import type { FamilyTierOption } from '@/lib/plans';

import { INITIAL_SIGNUP_STATE, signupAction } from './actions';

interface SignupFormProps {
  readonly plans: readonly FamilyTierOption[];
}

export function SignupForm({ plans }: SignupFormProps): React.JSX.Element {
  const [state, formAction, pending] = useActionState(signupAction, INITIAL_SIGNUP_STATE);
  const firstPlanCode = plans[0]?.code ?? '';
  const [selectedPlan, setSelectedPlan] = useState<string>(firstPlanCode);

  return (
    <form className="auth-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}

      <fieldset className="plan-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--espresso)',
            marginBottom: 8,
          }}
        >
          Choose a starting plan
        </legend>
        {plans.map((plan) => {
          const checked = selectedPlan === plan.code;
          return (
            <label
              key={plan.code}
              className={`plan-card${checked ? ' selected' : ''}`}
              htmlFor={`plan-${plan.code}`}
            >
              <input
                id={`plan-${plan.code}`}
                type="radio"
                name="plan"
                value={plan.code}
                checked={checked}
                onChange={() => setSelectedPlan(plan.code)}
              />
              <span className="plan-name">{plan.name}</span>
              <span className="plan-price">{plan.monthlyPriceLabel}</span>
              <span className="plan-detail">{plan.description}</span>
            </label>
          );
        })}
      </fieldset>

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
          autoComplete="new-password"
          minLength={8}
          maxLength={64}
          required
        />
        <span className="help">At least 8 characters. Longer passphrases are stronger.</span>
      </label>

      <button type="submit" className="submit" disabled={pending}>
        {pending ? 'Setting up your account…' : 'Create account'}
      </button>
    </form>
  );
}
