'use client';

import { useActionState } from 'react';

import { INITIAL_BOOKING_REQUEST_STATE, requestBookingAction } from './actions';

interface BookingRequestFormProps {
  readonly providerId: string;
  readonly providerName: string | null;
  readonly householdId: string;
  readonly seniorId: string;
  /**
   * Originating search-correlation token (TS-217-prep-4c), when the family
   * arrived from a provider-discovery search. Carried as a hidden field so the
   * concierge-request POST echoes it onto `booking.created` for precise
   * per-search conversion attribution. Null for a direct-link visit.
   */
  readonly searchId: string | null;
}

const SERVICE_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  {
    value: 'companion_dining',
    label: 'Companion dining',
    description: 'A chef prepares and shares a meal with your loved one.',
  },
  {
    value: 'personal_chef_visit',
    label: 'Personal chef visit',
    description: 'A chef visits to cook for the week or for a specific occasion.',
  },
  {
    value: 'grocery_coordination',
    label: 'Grocery coordination',
    description: 'Shopping, pantry stocking, and meal prep for the week.',
  },
  {
    value: 'transportation',
    label: 'Transportation',
    description: 'A companion accompanies your loved one to and from an appointment.',
  },
  {
    value: 'social_outing',
    label: 'Social outing',
    description: 'A walk, a coffee, a museum visit — companionship out of the house.',
  },
  {
    value: 'event_dining',
    label: 'Event dining',
    description: 'Birthday dinners, anniversaries, holiday meals catered at home.',
  },
  {
    value: 'emergency_concierge',
    label: 'Emergency concierge',
    description: 'Same-day or next-day support after a hospital discharge or fall.',
  },
];

/**
 * Client island for the family-portal booking-request form (TS-125).
 *
 * Service-kind picker + date + time + duration + notes. Submission
 * routes through `requestBookingAction` which POSTs to the gateway's
 * concierge-request proxy. On success the action server-redirects to
 * `/bookings/[id]?requested=1` for the confirmation receipt.
 */
export function BookingRequestForm({
  providerId,
  providerName,
  householdId,
  seniorId,
  searchId,
}: BookingRequestFormProps): React.JSX.Element {
  const [state, formAction, pending] = useActionState(
    requestBookingAction,
    INITIAL_BOOKING_REQUEST_STATE,
  );

  return (
    <form className="booking-form" action={formAction}>
      {state.status === 'error' && state.message !== undefined ? (
        <div className="auth-alert" role="alert">
          {state.message}
        </div>
      ) : null}

      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="householdId" value={householdId} />
      <input type="hidden" name="seniorId" value={seniorId} />
      {searchId !== null ? <input type="hidden" name="searchId" value={searchId} /> : null}

      <p className="booking-form-context">
        {providerName !== null ? (
          <>
            You&apos;re requesting a visit with <strong>{providerName}</strong>.{' '}
          </>
        ) : (
          "You're requesting a visit. "
        )}
        Our concierge team confirms within 24 hours.
      </p>

      <fieldset className="service-kind-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>What kind of visit?</legend>
        {SERVICE_KIND_OPTIONS.map((opt, i) => (
          <label key={opt.value} className="service-kind-card" htmlFor={`sk-${opt.value}`}>
            <input
              id={`sk-${opt.value}`}
              type="radio"
              name="serviceKind"
              value={opt.value}
              defaultChecked={i === 0}
              required
            />
            <span className="service-kind-title">{opt.label}</span>
            <span className="service-kind-desc">{opt.description}</span>
          </label>
        ))}
      </fieldset>

      <div className="booking-form-row">
        <label htmlFor="booking-date">
          Date
          <input
            id="booking-date"
            type="date"
            name="scheduledDate"
            required
            min={new Date().toISOString().slice(0, 10)}
          />
        </label>
        <label htmlFor="booking-time">
          Time
          <input id="booking-time" type="time" name="scheduledTime" required />
        </label>
        <label htmlFor="booking-duration">
          Duration (hours)
          <input
            id="booking-duration"
            type="number"
            name="durationHours"
            min={1}
            max={8}
            step={0.5}
            defaultValue={2}
            required
          />
        </label>
      </div>

      <label htmlFor="booking-notes">
        Anything we should know?
        <textarea
          id="booking-notes"
          name="bookingNotes"
          rows={4}
          maxLength={2000}
          placeholder="Allergies, mobility notes, favorite dishes, door codes…"
        />
      </label>

      <button type="submit" className="submit" disabled={pending}>
        {pending ? 'Sending your request…' : 'Send to concierge'}
      </button>
    </form>
  );
}
