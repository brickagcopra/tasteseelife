import type { IncidentSeverity } from './incident-enums';

/**
 * Severity → SLA budget, in minutes (PDD §16.1 "severity triage
 * (low / medium / high / critical) with SLA timers").
 *
 * ⚠ PLACEHOLDER NUMBERS — engineering defaults pending product confirmation.
 * Welfare-response SLAs are a product / compliance decision (mandated-reporter
 * timelines vary by state, PRD §11.4); these values exist so the pipeline is
 * real end-to-end, not because anyone has signed off on them:
 *
 *   critical → 2 hours   (active-harm welfare/safety concern)
 *   high     → 8 hours   (same business day)
 *   medium   → 24 hours  (next business day)
 *   low      → 72 hours  (three days)
 *
 * Deliberately a constant, not env — the skeleton carries no dead config
 * (TS-070 / TS-221 / TS-280 convention). Env-tunability (or a per-category
 * budget matrix) arrives if/when ops needs to adjust budgets without a
 * deploy; re-triage (changing severity after open, which must recompute the
 * due date under audit) is a TS-301+ concern.
 */
export const SLA_BUDGET_MINUTES = {
  critical: 120,
  high: 480,
  medium: 1_440,
  low: 4_320,
} as const satisfies Record<IncidentSeverity, number>;

/**
 * The SLA deadline for an incident: `openedAt` + the severity's budget.
 *
 * Pure — no clock access; callers pass `openedAt` explicitly so the
 * computation is deterministic under test (CLAUDE.md §9.3) and stable under
 * backfill (a system event reported late keeps its original deadline).
 */
export function computeSlaDueAt(severity: IncidentSeverity, openedAt: Date): Date {
  return new Date(openedAt.getTime() + SLA_BUDGET_MINUTES[severity] * 60_000);
}
