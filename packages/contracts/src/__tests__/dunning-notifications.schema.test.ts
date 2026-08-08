import { describe, expect, it } from 'vitest';

import {
  BILLING_DUNNING_TEMPLATE_CODES,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLES,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLES,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLES,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLES,
  BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES,
  DUNNING_TEMPLATE_CATEGORY,
  DUNNING_TEMPLATE_CHANNEL,
  DUNNING_TEMPLATE_LOCALE,
  NotificationVariableEntrySchema,
} from '../index';

/**
 * TS-042-followup-3a3 — the billing / dunning template contracts.
 *
 * These constants are the shared surface between the service-notification
 * seed and the TS-042-followup-3a2 outbox consumer. The render endpoint
 * rejects a dispatch that omits a required variable or sends an unknown
 * one, so a drift between the two sides is a production 400 on an email a
 * family is waiting for — these assertions are what keep them in step.
 */

const LADDER = [
  {
    code: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
    variables: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLES,
    names: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES,
  },
  {
    code: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
    variables: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLES,
    names: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES,
  },
  {
    code: BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
    variables: BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLES,
    names: BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES,
  },
  {
    code: BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
    variables: BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLES,
    names: BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES,
  },
] as const;

describe('billing / dunning template contracts', () => {
  it('ships four rungs, all distinct, listed in ladder order', () => {
    expect(BILLING_DUNNING_TEMPLATE_CODES).toHaveLength(4);
    expect(new Set(BILLING_DUNNING_TEMPLATE_CODES).size).toBe(4);
    expect(BILLING_DUNNING_TEMPLATE_CODES).toEqual(LADDER.map((r) => r.code));
  });

  it('is an en-US transactional email ladder', () => {
    expect(DUNNING_TEMPLATE_LOCALE).toBe('en-US');
    expect(DUNNING_TEMPLATE_CHANNEL).toBe('email');
    // Not `marketing` — a notice that payment for a household's care did
    // not go through is a service communication, so it is not gated by the
    // marketing opt-out (TCPA / CAN-SPAM).
    expect(DUNNING_TEMPLATE_CATEGORY).toBe('transactional');
  });

  it.each(LADDER)('$code declares valid, unique, required variables', ({ variables }) => {
    for (const entry of variables) {
      expect(NotificationVariableEntrySchema.safeParse(entry).success).toBe(true);
      // Every variable is required: an optional one would render blank in
      // an email the family reads, with nothing to signal the omission.
      expect(entry.required).toBe(true);
      expect(entry.description).toBeDefined();
    }
    expect(new Set(variables.map((v) => v.name)).size).toBe(variables.length);
  });

  it.each(LADDER)('$code keeps its name tuple in step with its entries', ({ variables, names }) => {
    expect(variables.map((v) => v.name)).toEqual([...names]);
  });

  it('carries appName + billingUrl on every rung', () => {
    for (const { code, names } of LADDER) {
      expect(names, code).toContain('appName');
      expect(names, code).toContain('billingUrl');
    }
  });

  it('declares no money variable anywhere in the ladder', () => {
    // `subscription.payment_failed` carries no invoice total by design, so
    // a template variable for one could only be supplied by inventing it
    // from the plan price — which disagrees with the invoice whenever a
    // proration or coupon applies (CLAUDE.md §6: one source of truth).
    for (const { code, variables } of LADDER) {
      for (const entry of variables) {
        expect(entry.name, `${code} declares ${entry.name}`).not.toMatch(
          /amount|price|total|balance|usd|cents|minor/i,
        );
        expect(entry.type, `${code}.${entry.name}`).not.toBe('number');
      }
    }
  });

  it('pairs every nullable-source label with a boolean gate', () => {
    // The renderer's variable validation is all-or-nothing per declared
    // variable, so an event field that may be absent ships as a REQUIRED
    // boolean plus a REQUIRED string that is empty when the gate is false.
    for (const { code, variables } of LADDER) {
      const names = new Set(variables.map((v) => v.name));
      for (const entry of variables) {
        if (!entry.name.endsWith('Label')) continue;
        const gate = `has${entry.name.charAt(0).toUpperCase()}${entry.name.slice(1).replace(/Label$/, '')}`;
        const expectedGate = gate.replace('hasGraceUntil', 'hasGraceWindow');
        expect(names, `${code}: ${entry.name} has no boolean gate`).toContain(expectedGate);
        expect(variables.find((v) => v.name === expectedGate)?.type).toBe('boolean');
      }
    }
  });

  it('gives the first-failure rung the retry variables and no other rung them', () => {
    // The reassurance that a retry is coming is what distinguishes the
    // first rung; by the escalation the retry is no longer the news.
    for (const { code, names } of LADDER) {
      const hasRetryVars = names.some((n: string) => n.startsWith('hasNextAttempt'));
      expect(hasRetryVars, code).toBe(code === BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE);
    }
  });

  it('keeps grace-window variables off the recovered and paused rungs', () => {
    // Recovery has no deadline; the paused rung's deadline has already
    // passed and restating it reads as a reprimand.
    for (const code of [
      BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
      BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
    ]) {
      const rung = LADDER.find((r) => r.code === code);
      expect(
        rung?.names.some((n: string) => n.toLowerCase().includes('grace')),
        code,
      ).toBe(false);
    }
  });
});
