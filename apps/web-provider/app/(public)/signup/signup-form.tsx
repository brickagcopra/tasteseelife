'use client';

import { useActionState, useState } from 'react';

import type { ProviderTierOption } from '@/lib/tiers';

import { INITIAL_SIGNUP_STATE, signupAction } from './actions';

interface SignupFormProps {
  readonly tiers: readonly ProviderTierOption[];
}

export function SignupForm({ tiers }: SignupFormProps): React.JSX.Element {
  const [state, formAction, pending] = useActionState(signupAction, INITIAL_SIGNUP_STATE);
  const firstTierCode = tiers[0]?.code ?? '';
  const [selectedTier, setSelectedTier] = useState<string>(firstTierCode);

  return (
    <form className="auth-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}

      <fieldset className="tier-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--espresso)',
            marginBottom: 8,
          }}
        >
          Choose a starting tier
        </legend>
        {tiers.map((tier) => {
          const checked = selectedTier === tier.code;
          return (
            <label
              key={tier.code}
              className={`tier-card${checked ? ' selected' : ''}`}
              htmlFor={`tier-${tier.code}`}
            >
              <input
                id={`tier-${tier.code}`}
                type="radio"
                name="tier"
                value={tier.code}
                checked={checked}
                onChange={() => setSelectedTier(tier.code)}
              />
              <span className="tier-name">{tier.name}</span>
              <span className="tier-price">{tier.monthlyPriceLabel}</span>
              <span className="tier-detail">{tier.description}</span>
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
        {pending ? 'Creating your account…' : 'Apply to be a provider'}
      </button>
    </form>
  );
}
