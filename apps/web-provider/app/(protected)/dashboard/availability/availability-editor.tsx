'use client';

import {
  PROVIDER_AVAILABILITY_EXCEPTIONS_MAX,
  PROVIDER_AVAILABILITY_WEEKDAY_VALUES,
  PROVIDER_AVAILABILITY_WINDOWS_MAX,
  type ProviderAvailabilityRecord,
  type ProviderAvailabilityWeekday,
} from '@taste-and-see/contracts';
import { useActionState, useState } from 'react';

import {
  INITIAL_AVAILABILITY_EDITOR_STATE,
  deleteAvailabilityAction,
  updateAvailabilityAction,
} from './actions';

interface AvailabilityEditorProps {
  readonly availability: ProviderAvailabilityRecord;
}

interface WindowDraft {
  readonly id: string;
  weekday: ProviderAvailabilityWeekday;
  startTime: string;
  endTime: string;
}

interface ExceptionDraft {
  readonly id: string;
  date: string;
}

/**
 * Multi-section availability editor (TS-203).
 *
 * Sections:
 *   - Recurring weekly windows — one row per (weekday, startTime,
 *     endTime). Add / remove rows inline; the server action
 *     validates overlap + ordering at submit time.
 *   - Date-keyed exclusions — one row per blackout date. Add / remove
 *     rows inline.
 *
 * Submission shape:
 *   The form posts FormData carrying every draft row as repeated
 *   indexed inputs (e.g. `windows[0].weekday=monday`,
 *   `windows[0].startTime=09:00`). The server action parses the
 *   FormData into the contract's JSON shape, three-layer-validates
 *   it (client form → server action → downstream service), then
 *   forwards to the gateway PUT proxy.
 *
 * The "Clear my schedule" button calls the sibling DELETE server
 * action; the editor re-renders with empty drafts after a successful
 * clear.
 */
export function AvailabilityEditor({ availability }: AvailabilityEditorProps): React.JSX.Element {
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateAvailabilityAction,
    INITIAL_AVAILABILITY_EDITOR_STATE,
  );
  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteAvailabilityAction,
    INITIAL_AVAILABILITY_EDITOR_STATE,
  );

  // Local state seeded from the server snapshot. Re-renders after
  // a successful update or delete because the server action calls
  // `revalidatePath` and the parent server component re-fetches.
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    availability.windows.map((w, index) => ({
      id: `w-${index}`,
      weekday: w.weekday,
      startTime: w.startTime,
      endTime: w.endTime,
    })),
  );
  const [exceptions, setExceptions] = useState<ExceptionDraft[]>(() =>
    availability.exceptions.map((e, index) => ({
      id: `e-${index}`,
      date: e.date,
    })),
  );

  const status = deleteState.status === 'idle' ? updateState : deleteState;
  const pending = updatePending || deletePending;

  function addWindow(): void {
    if (windows.length >= PROVIDER_AVAILABILITY_WINDOWS_MAX) return;
    setWindows((prev) => [
      ...prev,
      {
        id: `w-${Date.now()}-${prev.length}`,
        weekday: 'monday',
        startTime: '09:00',
        endTime: '13:00',
      },
    ]);
  }

  function removeWindow(id: string): void {
    setWindows((prev) => prev.filter((w) => w.id !== id));
  }

  function updateWindow(id: string, patch: Partial<WindowDraft>): void {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }

  function addException(): void {
    if (exceptions.length >= PROVIDER_AVAILABILITY_EXCEPTIONS_MAX) return;
    setExceptions((prev) => [
      ...prev,
      {
        id: `e-${Date.now()}-${prev.length}`,
        date: '',
      },
    ]);
  }

  function removeException(id: string): void {
    setExceptions((prev) => prev.filter((e) => e.id !== id));
  }

  function updateException(id: string, patch: Partial<ExceptionDraft>): void {
    setExceptions((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  return (
    <>
      <form
        className="auth-form"
        action={updateFormAction}
        aria-describedby="availability-form-status"
      >
        <input type="hidden" name="providerId" value={availability.providerId} />

        <div id="availability-form-status" aria-live="polite">
          {status.status === 'error' && status.message !== undefined ? (
            <div className="auth-alert" role="alert">
              {status.message}
            </div>
          ) : null}
          {status.status === 'success' && status.message !== undefined ? (
            <div className="auth-alert auth-alert-success" role="status">
              {status.message}
            </div>
          ) : null}
        </div>

        <section className="profile-section" aria-labelledby="section-windows">
          <h2 id="section-windows" className="profile-section-heading">
            Recurring weekly windows
          </h2>
          <p className="help">
            Add a window for each shift you typically work. Multiple windows on the same day are
            fine, as long as they do not overlap. Times are in your local timezone (
            <strong>{availability.timeZone}</strong>). Up to {PROVIDER_AVAILABILITY_WINDOWS_MAX}{' '}
            windows.
          </p>

          {windows.length === 0 ? (
            <p className="help">
              No windows yet. Click <strong>Add window</strong> to start.
            </p>
          ) : null}

          {windows.map((window, index) => (
            <div key={window.id} className="profile-section">
              <input type="hidden" name={`windows[${index}].weekday`} value={window.weekday} />
              <input type="hidden" name={`windows[${index}].startTime`} value={window.startTime} />
              <input type="hidden" name={`windows[${index}].endTime`} value={window.endTime} />
              <label htmlFor={`weekday-${window.id}`}>
                Weekday
                <select
                  id={`weekday-${window.id}`}
                  value={window.weekday}
                  onChange={(event) =>
                    updateWindow(window.id, {
                      weekday: event.target.value as ProviderAvailabilityWeekday,
                    })
                  }
                >
                  {PROVIDER_AVAILABILITY_WEEKDAY_VALUES.map((weekday) => (
                    <option key={weekday} value={weekday}>
                      {capitalize(weekday)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={`start-${window.id}`}>
                Start time
                <input
                  id={`start-${window.id}`}
                  type="time"
                  value={window.startTime}
                  onChange={(event) => updateWindow(window.id, { startTime: event.target.value })}
                />
              </label>
              <label htmlFor={`end-${window.id}`}>
                End time
                <input
                  id={`end-${window.id}`}
                  type="time"
                  value={window.endTime}
                  onChange={(event) => updateWindow(window.id, { endTime: event.target.value })}
                />
              </label>
              <button type="button" onClick={() => removeWindow(window.id)} className="submit">
                Remove window
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addWindow}
            className="submit"
            disabled={windows.length >= PROVIDER_AVAILABILITY_WINDOWS_MAX}
          >
            Add window
          </button>
        </section>

        <section className="profile-section" aria-labelledby="section-exceptions">
          <h2 id="section-exceptions" className="profile-section-heading">
            Blackout dates
          </h2>
          <p className="help">
            One-off dates when you are not available — vacations, conferences, personal events.
            Recurring windows on these dates are blocked automatically. Up to{' '}
            {PROVIDER_AVAILABILITY_EXCEPTIONS_MAX} dates.
          </p>

          {exceptions.length === 0 ? (
            <p className="help">
              No blackout dates yet. Click <strong>Add blackout date</strong> if you have any to
              declare.
            </p>
          ) : null}

          {exceptions.map((exception, index) => (
            <div key={exception.id} className="profile-section">
              <input type="hidden" name={`exceptions[${index}].date`} value={exception.date} />
              <label htmlFor={`date-${exception.id}`}>
                Blackout date
                <input
                  id={`date-${exception.id}`}
                  type="date"
                  value={exception.date}
                  onChange={(event) => updateException(exception.id, { date: event.target.value })}
                />
              </label>
              <button
                type="button"
                onClick={() => removeException(exception.id)}
                className="submit"
              >
                Remove
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addException}
            className="submit"
            disabled={exceptions.length >= PROVIDER_AVAILABILITY_EXCEPTIONS_MAX}
          >
            Add blackout date
          </button>
        </section>

        <button type="submit" className="submit" disabled={pending}>
          {updatePending ? 'Saving…' : 'Save schedule'}
        </button>
      </form>

      <form action={deleteFormAction} style={{ marginTop: 24 }}>
        <input type="hidden" name="providerId" value={availability.providerId} />
        <p className="help">
          Cleared the whole schedule and want to start over? This wipes every window and blackout
          date.
        </p>
        <button type="submit" className="submit" disabled={pending}>
          {deletePending ? 'Clearing…' : 'Clear my schedule'}
        </button>
      </form>
    </>
  );
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
