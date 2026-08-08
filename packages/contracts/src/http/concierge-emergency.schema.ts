import { z } from 'zod';

import { ConciergeTicketRecordSchema } from './concierge-ticket.schema';

/**
 * Emergency concierge-assistance HTTP DTOs (TS-225; PRD §5.1 Tier 3
 * "emergency concierge assistance"; PDD §16.1, §20.5).
 *
 * The family-portal emergency surface is a deliberately distinct channel
 * from the TS-223 custom-request submission: it always opens a
 * high-severity `emergency_assistance` ticket (escalated immediately on the
 * `emergency_on_call` path, with the tightened 1-hour SLA) AND pages the
 * on-call concierge supervisor via PagerDuty. TS-223 deliberately excluded
 * `emergency_assistance` from its family-submittable kinds, noting it gets
 * "its own surface with distinct routing + escalation" — this is it.
 *
 * **Trigger payload.** The family supplies a small fixed `category` (so the
 * on-call responder has a structured triage signal) plus an optional
 * free-text `note`. Under stress the category alone is enough; the note adds
 * context when there's time. The category drives the ticket subject + the
 * PagerDuty page summary; the note becomes the ticket body that the ops
 * console (TS-224) surfaces. The note is deliberately NOT forwarded to
 * PagerDuty (it may carry household PII the family typed in the moment) —
 * the page links the responder to the ops-console ticket for the detail.
 *
 * **No Tier-3 hard gate.** Emergency assistance is reachable by any
 * authenticated household — blocking a safety surface on a billing-tier
 * read would be dangerous, and the tier-gate cross-service read is deferred
 * across the concierge surfaces anyway (TS-222-followup-3 / TS-223-followup-3).
 * The Tier-3 positioning lives in the UI copy, not a hard 403.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/**
 * Free-text note the family can add to the emergency trigger. Maps to the
 * ticket `body`. Bounded shorter than a normal request body — an emergency
 * note is a quick line of context, not an essay.
 */
export const CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH = 2000;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Emergency triage category. A small fixed set so the on-call responder
 * gets a structured signal the moment the page fires. Additive only — a new
 * category appends to the end (a consumer that does not recognise a new
 * value should treat it as `other`).
 *
 *   `medical`     = a possible medical concern (a fall, unresponsiveness,
 *                   a health scare). Not a substitute for 911 — the UI copy
 *                   says so — but the concierge channel for "something is
 *                   wrong and I need help now".
 *   `safety`      = a safety / security concern at the home.
 *   `urgent_need` = an urgent non-medical need (a missed essential, a
 *                   sudden gap in care, a time-critical logistics problem).
 *   `other`       = anything else that can't wait for the normal request
 *                   queue.
 */
export const ConciergeEmergencyCategorySchema = z.enum([
  'medical',
  'safety',
  'urgent_need',
  'other',
]);
export type ConciergeEmergencyCategory = z.infer<typeof ConciergeEmergencyCategorySchema>;

// ─── Field schemas ──────────────────────────────────────────────────────

const NoteSchema = z
  .string()
  .trim()
  .min(1, 'a note cannot be empty when provided')
  .max(CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH);

// ─── Request / response shapes ──────────────────────────────────────────

/**
 * `POST /api/v1/concierge/emergency` body — trigger emergency concierge
 * assistance. `category` is required; `note` is optional context.
 */
export const TriggerEmergencyAssistanceRequestSchema = z
  .object({
    category: ConciergeEmergencyCategorySchema,
    note: NoteSchema.optional(),
  })
  .strict();
export type TriggerEmergencyAssistanceRequest = z.infer<
  typeof TriggerEmergencyAssistanceRequestSchema
>;

/**
 * `POST /api/v1/concierge/emergency` response — the created high-severity
 * ticket (`kind='emergency_assistance'`, `status='escalated'`,
 * `escalationPath='emergency_on_call'`, the 1-hour SLA). Whether the
 * PagerDuty page was dispatched is an internal observability concern (logged
 * + metered), NOT a family-facing field — the ticket is always created and
 * the concierge team is always notified, so the family sees an unconditional
 * reassuring confirmation.
 */
export const TriggerEmergencyAssistanceResponseSchema = z
  .object({
    ticket: ConciergeTicketRecordSchema,
  })
  .strict();
export type TriggerEmergencyAssistanceResponse = z.infer<
  typeof TriggerEmergencyAssistanceResponseSchema
>;
