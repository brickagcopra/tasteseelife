import {
  BILLING_DUNNING_TEMPLATE_CODES,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { MjmlCompilerService } from '../services/mjml-compiler.service';

import {
  buildBillingDunningTemplateSeeds,
  seedBillingDunningTemplates,
} from './billing-dunning-templates';

const seeds = buildBillingDunningTemplateSeeds();
const byCode = new Map(seeds.map((s) => [s.code, s]));

/** Expected variable names per rung, sourced from the shared contract. */
const EXPECTED_VARIABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
    BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES,
  ],
  [
    BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
    BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES,
  ],
  [BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE, BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES],
  [BILLING_SERVICE_PAUSED_TEMPLATE_CODE, BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES],
];

describe('buildBillingDunningTemplateSeeds', () => {
  it('covers exactly the ladder declared in contracts, in ladder order', () => {
    expect(seeds.map((s) => s.code)).toEqual([...BILLING_DUNNING_TEMPLATE_CODES]);
  });

  it('targets en_US + the email kind on every rung', () => {
    for (const seed of seeds) {
      expect(seed.dbLocale, seed.code).toBe('en_US');
      expect(seed.kind, seed.code).toBe('email');
    }
  });

  it.each(EXPECTED_VARIABLES)(
    '%s declares exactly its shared contract variable set',
    (code, names) => {
      const seed = byCode.get(code);
      expect(seed).toBeDefined();
      expect(seed?.variablesSchema.map((v) => v.name)).toEqual([...names]);
    },
  );

  it('references every declared variable in the subject or one of the bodies', () => {
    for (const seed of seeds) {
      const haystack = `${seed.subject}\n${seed.bodyMjml}\n${seed.bodyText}`;
      for (const { name } of seed.variablesSchema) {
        expect(haystack, `${seed.code} never references {{${name}}}`).toContain(name);
      }
    }
  });

  it('compiles every MJML body without errors', () => {
    const mjml = new MjmlCompilerService();
    for (const seed of seeds) {
      expect(mjml.compile(seed.bodyMjml).outcome, seed.code).toBe('ok');
    }
  });

  it('gives every rung a distinct subject line', () => {
    const subjects = new Set(seeds.map((s) => s.subject));
    expect(subjects.size).toBe(seeds.length);
  });

  it('carries the billing link and the plain-text fallback on every rung', () => {
    for (const seed of seeds) {
      expect(seed.bodyMjml, seed.code).toContain('{{billingUrl}}');
      expect(seed.bodyText, seed.code).toContain('{{billingUrl}}');
      expect(seed.bodyText.length, seed.code).toBeGreaterThan(0);
    }
  });

  /**
   * The copy constraints from the task + CLAUDE.md §12, asserted rather
   * than merely documented. These are the properties a future copy edit is
   * most likely to break, and the failure mode is a real email to a real
   * family — not a broken build.
   */
  describe('copy constraints', () => {
    const allCopy = seeds.map((s) => ({
      code: s.code,
      text: `${s.subject}\n${s.bodyMjml}\n${s.bodyText}`,
    }));

    it('never states or promises a monetary amount', () => {
      // The event carries no invoice total by design, so any currency
      // symbol or amount-shaped phrase in the copy would be invented.
      for (const { code, text } of allCopy) {
        expect(text, `${code} mentions a currency symbol`).not.toMatch(/[$£€]/);
        expect(text, `${code} promises an amount`).not.toMatch(/amount (due|owed)|balance due/i);
      }
    });

    it('never declares a money-typed or amount-named variable', () => {
      for (const seed of seeds) {
        for (const { name } of seed.variablesSchema) {
          expect(name, `${seed.code} declares ${name}`).not.toMatch(/amount|price|total|balance/i);
        }
      }
    });

    it('never states the attempt count', () => {
      for (const { code, text } of allCopy) {
        expect(text, `${code} states an attempt count`).not.toMatch(/attempt\s*(#|\d|count)/i);
      }
      for (const seed of seeds) {
        expect(
          seed.variablesSchema.map((v) => v.name),
          `${seed.code} declares an attempt-count variable`,
        ).not.toContain('attemptCount');
      }
    });

    /**
     * The inverse of the test that stood here until
     * TS-042-followup-3a3-followup-1 (TS-042-followup-3a3).
     *
     * That test forbade "update your card" because the platform had no
     * surface that could do it — `{{billingUrl}}` pointed at a read-only
     * invoice list. The Billing Portal endpoint and `/billing` now exist,
     * so the property worth enforcing has flipped: the rungs that ask a
     * family to act must name the act. A ladder whose call to action is
     * "review your billing details" is one a worried reader can follow
     * without ever finding the thing that fixes it.
     *
     * **If `{{billingUrl}}` is ever pointed back at a page that cannot
     * update a card, this test is the one that must fail.** It is
     * deliberately paired with the env var: `DUNNING_BILLING_URL` and
     * service-subscription's `BILLING_PORTAL_RETURN_URL` both address
     * `/billing`.
     */
    it('names the card update on the three rungs that need action', () => {
      const actionable = allCopy.filter(({ code }) => !code.includes('recovered'));
      expect(actionable.length).toBeGreaterThan(0);
      for (const { code, text } of actionable) {
        expect(text, `${code} never names updating a card`).toMatch(
          /update (your |the )?card|update your (payment method|payment details)/i,
        );
      }
    });

    it('does NOT ask the recovered rung to update anything', () => {
      // Telling someone to fix a payment that just succeeded reads as a
      // second failure.
      const recovered = allCopy.filter(({ code }) => code.includes('recovered'));
      expect(recovered.length).toBeGreaterThan(0);
      for (const { code, text } of recovered) {
        expect(text, `${code} asks for an action after recovery`).not.toMatch(
          /update your (card|payment method|payment details)/i,
        );
      }
    });

    it('uses collections language nowhere', () => {
      for (const { code, text } of allCopy) {
        // `\bowe\b` and not `owe` — "however" contains it.
        expect(text, `${code} uses collections framing`).not.toMatch(
          /overdue|delinquen|past due|arrears|\bowes?d?\b|\bdebt\b|immediately/i,
        );
      }
    });

    it('names no senior and no recipient — the resolver chain yields neither', () => {
      for (const seed of seeds) {
        for (const { name } of seed.variablesSchema) {
          // `appName` is the product, not a person; any OTHER `*Name`
          // variable would be a person this platform cannot resolve.
          if (name === 'appName') continue;
          expect(name, `${seed.code} declares ${name}`).not.toMatch(/name$/i);
        }
        expect(seed.variablesSchema.map((v) => v.name)).toContain('appName');
      }
    });

    it('states reversibility on the paused rung', () => {
      const paused = byCode.get(BILLING_SERVICE_PAUSED_TEMPLATE_CODE);
      expect(paused?.bodyMjml).toMatch(/reversible/i);
      expect(paused?.bodyText).toMatch(/reversible/i);
    });

    it('gates every optional-event-field variable behind a boolean', () => {
      // `graceUntil` is nullable and `nextAttemptAt` optional on the event,
      // so each label must sit inside an `{{#if}}` or the family reads
      // "we'll try again on ." — see the schema doc-block.
      const first = byCode.get(BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE);
      expect(first?.bodyMjml).toContain('{{#if hasNextAttempt}}');
      expect(first?.bodyMjml).toContain('{{#if hasGraceWindow}}');
      expect(first?.bodyText).toContain('{{#if hasNextAttempt}}');
      expect(first?.bodyText).toContain('{{#if hasGraceWindow}}');

      const retry = byCode.get(BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE);
      expect(retry?.bodyMjml).toContain('{{#if hasGraceWindow}}');
      expect(retry?.bodyText).toContain('{{#if hasGraceWindow}}');
    });

    it('keeps HTML entities out of subject lines', () => {
      for (const seed of seeds) {
        expect(seed.subject, `${seed.code} subject carries an HTML entity`).not.toMatch(/&\w+;/);
      }
    });
  });
});

/**
 * Fake Prisma surface — only the four calls the shared seeder makes.
 * Mirrors the wellness-summary / certification-renewal seed tests.
 */
function makeFakePrisma(opts: {
  existing: { id: string; activeVersionId: string | null } | null;
  headVersion: number | null;
}) {
  const calls = { created: 0, versionCreated: 0, activated: 0 };
  const tx = {
    notificationTemplate: {
      create: vi.fn(async () => {
        calls.created += 1;
        return { id: 'tpl_new', activeVersionId: null };
      }),
      update: vi.fn(async () => {
        calls.activated += 1;
        return {};
      }),
    },
    notificationTemplateVersion: {
      findFirst: vi.fn(async () =>
        opts.headVersion === null ? null : { version: opts.headVersion },
      ),
      create: vi.fn(async () => {
        calls.versionCreated += 1;
        return { id: 'ver_1', version: (opts.headVersion ?? 0) + 1 };
      }),
    },
  };
  const prisma = {
    notificationTemplate: {
      findUnique: vi.fn(async () => opts.existing),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx, calls };
}

describe('seedBillingDunningTemplates', () => {
  const mjml = new MjmlCompilerService();

  it('creates + activates all four rungs when nothing exists', async () => {
    const { prisma, calls } = makeFakePrisma({ existing: null, headVersion: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const reports = await seedBillingDunningTemplates(prisma as any, mjml);

    expect(reports.map((r) => r.templateCode)).toEqual([...BILLING_DUNNING_TEMPLATE_CODES]);
    expect(reports.every((r) => r.outcome === 'created')).toBe(true);
    expect(calls).toEqual({ created: 4, versionCreated: 4, activated: 4 });
  });

  it('is a no-op for a rung that already has an active version', async () => {
    const { prisma, calls } = makeFakePrisma({
      existing: { id: 'tpl_1', activeVersionId: 'ver_active' },
      headVersion: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const reports = await seedBillingDunningTemplates(prisma as any, mjml);

    expect(reports.every((r) => r.outcome === 'already_active')).toBe(true);
    expect(reports.every((r) => r.version === null)).toBe(true);
    expect(calls).toEqual({ created: 0, versionCreated: 0, activated: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('activates a fresh version for a rung that exists without one', async () => {
    const { prisma, tx, calls } = makeFakePrisma({
      existing: { id: 'tpl_1', activeVersionId: null },
      headVersion: 2,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const reports = await seedBillingDunningTemplates(prisma as any, mjml);

    expect(reports.every((r) => r.outcome === 'activated_existing')).toBe(true);
    expect(reports.every((r) => r.version === 3)).toBe(true);
    expect(calls).toEqual({ created: 0, versionCreated: 4, activated: 4 });
    expect(tx.notificationTemplate.create).not.toHaveBeenCalled();
  });
});
