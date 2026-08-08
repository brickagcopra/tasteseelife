'use client';

import { useEffect, useState } from 'react';

import { FLASH_COOKIE_NAME, type FlashKind, type FlashPayload } from '@/lib/flash-types';

/**
 * One-shot flash banner (TS-215-followup-3).
 *
 * Receives the server-read payload as `initial`. On mount, clears the
 * `tas_family_flash` cookie via `document.cookie` so a refresh (or a
 * navigation back to a protected page) does not redisplay the banner.
 *
 * The cookie is intentionally NOT HttpOnly so client JS can clear it
 * — flash payloads carry no secret content (only a short UX hint).
 * See `lib/flash.ts` for the security rationale.
 *
 * The banner is non-blocking: it sits above the page content with
 * `role="status"` so a screen reader announces it without stealing
 * focus from the surrounding flow.
 */
export function FlashBanner({
  initial,
}: {
  readonly initial: FlashPayload | null;
}): React.JSX.Element | null {
  const [payload, setPayload] = useState<FlashPayload | null>(initial);

  useEffect(() => {
    if (payload === null) return;
    /*
     * Clear the cookie on mount. Setting Max-Age=0 is the RFC 6265
     * idiom for an immediate delete; Path=/ matches the server-side
     * write so the browser deletes the right cookie. Secure attribute
     * is conditional on the protocol — `document.cookie` setters
     * silently ignore `Secure` on http:// origins (local dev),
     * so we set it everywhere and let the browser decide.
     */
    document.cookie = `${FLASH_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  }, [payload]);

  if (payload === null) return null;

  return (
    <div
      className={`flash-banner flash-banner--${payload.kind}`}
      role={payload.kind === 'error' ? 'alert' : 'status'}
      aria-live={payload.kind === 'error' ? 'assertive' : 'polite'}
    >
      <span className="flash-banner-icon" aria-hidden="true">
        {iconFor(payload.kind)}
      </span>
      <p className="flash-banner-message">{payload.message ?? messageFor(payload.code)}</p>
      <button
        type="button"
        className="flash-banner-close"
        aria-label="Dismiss notification"
        onClick={() => setPayload(null)}
      >
        ×
      </button>
    </div>
  );
}

function iconFor(kind: FlashKind): string {
  if (kind === 'success') return '✓';
  if (kind === 'error') return '!';
  return 'i';
}

/**
 * Map known flash codes to user-facing copy. Codes the renderer does
 * not recognise fall back to a generic "Something went wrong" line so
 * the user always sees a hint instead of a blank banner. This list is
 * deliberately exhaustive at the renderer — new actions that introduce
 * codes should add an entry here in the same PR.
 */
function messageFor(code: string): string {
  switch (code) {
    case 'save_current_search.ok':
      return 'Saved. You can re-run this search from your saved searches.';
    case 'save_current_search.missing_name':
      return 'Please give your search a name before saving.';
    case 'save_current_search.failed':
      return "We couldn't save your search. Please try again in a moment.";
    case 'toggle_favorite.failed':
      return "We couldn't update your favourite. Please try again in a moment.";
    case 'run_saved_search.failed':
      return "We couldn't run your saved search. Please try again in a moment.";
    case 'delete_saved_search.failed':
      return "We couldn't remove your saved search. Please try again in a moment.";
    case 'add_favorite.failed':
      return "We couldn't add this chef to your favourites. Please try again in a moment.";
    case 'remove_favorite.failed':
      return "We couldn't remove this favourite. Please try again in a moment.";
    case 'senior_preferences.saved':
      return 'Saved. Thank you for sharing — it helps every visit feel more personal.';
    case 'senior_preferences.unchanged':
      return 'Nothing to update — these preferences are already up to date.';
    case 'senior_preferences.not_found':
      return "We couldn't find that loved one in your household.";
    case 'senior_preferences.load_failed':
      return "We couldn't load these preferences right now. Please try again in a moment.";
    case 'senior_preferences.save_failed':
      return "We couldn't save these preferences. Please try again in a moment.";
    case 'senior_consent.saved':
      return 'Saved. Your sharing choices are in effect.';
    case 'senior_consent.forbidden':
      return 'Only the primary account holder or the senior themselves can change sharing settings.';
    case 'senior_consent.not_found':
      return "We couldn't find that loved one in your household.";
    case 'senior_consent.save_failed':
      return "We couldn't save these sharing settings. Please try again in a moment.";
    case 'senior_alerts.saved':
      return 'Saved. Your alert choices are in effect.';
    case 'senior_alerts.not_found':
      return "We couldn't find that loved one in your household.";
    case 'senior_alerts.save_failed':
      return "We couldn't save these alert settings. Please try again in a moment.";
    case 'concierge_request.submitted':
      return 'Sent. Your concierge will follow up to confirm the details.';
    case 'concierge_request.invalid':
      return 'Please add a title and a few details before sending your request.';
    case 'concierge_request.failed':
      return "We couldn't send your request. Please try again in a moment.";
    case 'concierge_emergency.triggered':
      return 'Help is on the way. Our on-call concierge team has been alerted and will reach out right away.';
    case 'concierge_emergency.invalid':
      return 'Please choose what kind of help you need before sending.';
    case 'concierge_emergency.failed':
      return "We couldn't send your emergency request. Please try again — and if it's life-threatening, call 911.";
    // Billing portal (TS-042-followup-3a3-followup-1). A family reaching
    // this from a dunning email is already anxious about their care; the
    // copy names what to do next rather than what went wrong.
    case 'billing_portal.no_plan':
      return "We couldn't find a plan on your account to manage. If you think that's wrong, reply to any message from us and we'll sort it out.";
    case 'billing_portal.failed':
      return "We couldn't open your billing details just now. Please try again in a moment — nothing about your plan has changed.";
    case 'report_concern.invalid':
      return 'Please choose a topic and tell us what happened before sending.';
    case 'report_concern.failed':
      return "We couldn't send your report. Please try again in a moment — and if someone is in immediate danger, call 911.";
    // Privacy Center (TS-309d). `mfa_required` is not an error the person
    // made — it is us saying we need to be sure who we're speaking to before
    // we act on a request about somebody's personal information.
    case 'privacy.mfa_required':
      return 'Before we can accept a privacy request, we need to be certain it’s really you. Please sign in again with your two-step code, then try once more.';
    case 'privacy.invalid':
      return 'Please choose what you’d like to ask for, and who it’s about.';
    case 'privacy.duplicate':
      return 'You already have an open request just like this one — we’re working on it.';
    case 'privacy.not_found':
      return "We couldn't find that request.";
    case 'privacy.already_closed':
      return 'That request has already been closed, so there’s nothing to withdraw.';
    case 'privacy.failed':
      return "We couldn't send your request. Please try again in a moment.";
    // Sign-in security (TS-309d-followup-1). No "2FA", no "factor" — the
    // audience includes seniors and the family members helping them.
    case 'mfa.removed':
      return 'Your authenticator has been removed. Your account is now protected by your password alone.';
    case 'mfa.not_found':
      return "We couldn't find that authenticator — it may already have been removed.";
    case 'mfa.invalid':
      return 'Please choose which authenticator to remove.';
    case 'mfa.failed':
      return "We couldn't update your security settings. Please try again in a moment.";
    default:
      return 'Something went wrong. Please try again in a moment.';
  }
}
