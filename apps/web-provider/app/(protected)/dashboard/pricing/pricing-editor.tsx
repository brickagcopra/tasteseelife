'use client';

import {
  PROVIDER_PRICING_DEFAULT_CURRENCY,
  type ProviderPricingRecord,
  type UpdateProviderPricingRequest,
} from '@taste-and-see/contracts';
import { useState, useTransition } from 'react';

import {
  INITIAL_PRICING_EDITOR_STATE,
  updatePricingAction,
  type PricingEditorActionState,
} from './actions';

interface PricingEditorProps {
  readonly pricing: ProviderPricingRecord;
}

/**
 * Provider pricing-band editor (TS-204).
 *
 * A single dollar-amount input the provider sets within the platform
 * band for their tier. The band (min / max) is rendered from the
 * snapshot's `band` so the provider sees the allowed range up front;
 * the server is the authoritative gate (out-of-band → 422), but a
 * client-side hint catches the obvious mistake before the round-trip.
 *
 * Money discipline (CLAUDE.md §17.6): the wire value is integer minor
 * units (cents). Dollar ⇄ minor conversion here is integer-safe (split
 * on `.`, accumulate in integer space) — no float math touches the
 * amount.
 *
 * Accessibility: the input is labelled, the band + currency are help
 * text, and an `aria-live` region announces save / error copy.
 */
export function PricingEditor({ pricing }: PricingEditorProps): React.JSX.Element {
  const [actionState, setActionState] = useState<PricingEditorActionState>(
    INITIAL_PRICING_EDITOR_STATE,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const minDollars = minorToDollarsString(pricing.band.minHourlyRateMinor);
  const maxDollars = minorToDollarsString(pricing.band.maxHourlyRateMinor);

  const [rateInput, setRateInput] = useState(
    minorToDollarsString(pricing.hourlyRateMinor ?? pricing.band.minHourlyRateMinor),
  );

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const minor = dollarsStringToMinor(rateInput);
    if (minor === null) {
      setLocalError('Enter a dollar amount like 75 or 75.00.');
      return;
    }
    if (minor < pricing.band.minHourlyRateMinor || minor > pricing.band.maxHourlyRateMinor) {
      setLocalError(
        `Your rate must be between $${minDollars} and $${maxDollars} for the ${pricing.tier} tier.`,
      );
      return;
    }
    setLocalError(null);

    startTransition(async () => {
      const values: UpdateProviderPricingRequest = {
        hourlyRateMinor: minor,
        currency: PROVIDER_PRICING_DEFAULT_CURRENCY,
      };
      const result = await updatePricingAction({
        providerId: pricing.providerId,
        ifMatch: pricing.updatedAt,
        values,
      });
      setActionState(result);
    });
  };

  const displayedError =
    localError ?? (actionState.status === 'error' ? actionState.message : undefined);

  return (
    <form
      className="auth-form"
      onSubmit={onSubmit}
      aria-describedby="pricing-form-status"
      noValidate
    >
      <div id="pricing-form-status" aria-live="polite">
        {actionState.status === 'success' && actionState.message !== undefined ? (
          <div className="auth-alert auth-alert-success" role="status">
            {actionState.message}
          </div>
        ) : null}
      </div>

      <section className="profile-section" aria-labelledby="section-rate">
        <h2 id="section-rate" className="profile-section-heading">
          Your hourly rate
        </h2>
        <dl className="profile-readonly-list">
          <div>
            <dt>Tier</dt>
            <dd>{pricing.tier}</dd>
          </div>
          <div>
            <dt>Allowed range</dt>
            <dd>
              ${minDollars} – ${maxDollars} / hour
            </dd>
          </div>
        </dl>
        <label htmlFor="hourlyRate">
          Hourly rate (USD)
          <input
            id="hourlyRate"
            type="text"
            inputMode="decimal"
            value={rateInput}
            onChange={(e) => {
              setRateInput(e.target.value);
              if (localError !== null) setLocalError(null);
            }}
            placeholder={minDollars}
            autoComplete="off"
            aria-invalid={displayedError !== undefined && displayedError !== null}
            aria-errormessage={displayedError ? 'pricing-error' : undefined}
          />
          <span className="help">
            Set a rate between ${minDollars} and ${maxDollars} per hour for the {pricing.tier} tier.
            Taste &amp; See is USD-only today.
          </span>
          {displayedError !== undefined && displayedError !== null ? (
            <span id="pricing-error" className="help error" role="alert">
              {displayedError}
            </span>
          ) : null}
        </label>
      </section>

      <button type="submit" className="submit" disabled={isPending}>
        {isPending ? 'Saving…' : 'Save rate'}
      </button>
    </form>
  );
}

/**
 * Parse a dollar-amount string (`"75"`, `"75.5"`, `"75.00"`) into
 * integer minor units. Integer-safe — no float math. Returns `null`
 * for any input that isn't a non-negative dollar amount with at most
 * two decimal places.
 */
function dollarsStringToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [dollars, cents = ''] = trimmed.split('.');
  const paddedCents = cents.padEnd(2, '0');
  const dollarsInt = Number.parseInt(dollars ?? '0', 10);
  const centsInt = Number.parseInt(paddedCents.length > 0 ? paddedCents : '0', 10);
  return dollarsInt * 100 + centsInt;
}

/**
 * Format integer minor units as a dollar string (`7500` → `"75.00"`).
 * Integer-safe — used for display + as the input seed.
 */
function minorToDollarsString(minor: number): string {
  const dollars = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${dollars}.${cents.toString().padStart(2, '0')}`;
}
