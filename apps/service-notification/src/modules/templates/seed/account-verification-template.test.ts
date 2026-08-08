import {
  ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE,
  ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_VARIABLES,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { buildAccountEmailVerificationTemplateSeed } from './account-verification-template';

const seed = buildAccountEmailVerificationTemplateSeed();
const copy = `${seed.subject}\n${seed.bodyMjml ?? ''}\n${seed.bodyText ?? ''}`;

describe('account email-verification template seed (TS-510-followup-4)', () => {
  it('is an en-US email keyed to the contract code', () => {
    expect(seed.code).toBe(ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE);
    expect(seed.kind).toBe('email');
    expect(seed.variablesSchema).toEqual(ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_VARIABLES);
  });

  it('renders every declared variable, and declares every variable it renders', () => {
    // A declared-but-unrendered variable is one the consumer must
    // populate for no reason; a rendered-but-undeclared one is a render
    // that 400s at dispatch time. Both forms count as "rendered":
    // `{{name}}` for values, `{{#if name}}` for the boolean branch.
    const declared = seed.variablesSchema.map((v) => v.name);
    for (const name of declared) {
      const used = copy.includes(`{{${name}}}`) || copy.includes(`{{#if ${name}}}`);
      expect(used, `${name} is declared but never rendered`).toBe(true);
    }

    const rendered = new Set(
      [...copy.matchAll(/\{\{(?:#if\s+)?([a-zA-Z][a-zA-Z0-9]*)\}\}/g)].map((m) => m[1]),
    );
    // Handlebars block keywords are syntax, not variables.
    rendered.delete('else');
    for (const name of rendered) {
      if (name === undefined) continue;
      expect(declared, `${name} is rendered but not declared`).toContain(name);
    }
  });

  it('carries the link in BOTH the HTML and the plain-text part', () => {
    // A text part without the link is a verification email that fails
    // silently for anyone reading in plain text.
    expect(seed.bodyMjml).toContain('{{verificationUrl}}');
    expect(seed.bodyText).toContain('{{verificationUrl}}');
  });

  it('states the expiry as a duration, never a timestamp', () => {
    expect(copy).toContain('{{expiresInLabel}}');
    expect(copy).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('tells an unexpected recipient to ignore it, not to contact support', () => {
    // The address is attacker-choosable, so the honest instruction is
    // that doing nothing costs nothing. "Secure your account" would
    // manufacture alarm out of a stranger's typo.
    expect(copy).toMatch(/ignore it/i);
    expect(copy).not.toMatch(/secure your account|contact (us|support) immediately/i);
  });

  it('names no person and asks for no personal detail', () => {
    for (const { name } of seed.variablesSchema) {
      // `appName` is the product, not a person. Any other `*Name` would
      // be someone this service cannot resolve without reading
      // identity.users across a service boundary.
      expect(name === 'appName' || !/name$/i.test(name)).toBe(true);
    }
    expect(copy).not.toMatch(/\{\{(firstName|lastName|fullName|userName)\}\}/);
  });

  it('makes no claim about what verification unlocks', () => {
    // Whether an unverified account is restricted is a product decision
    // nobody has made; a template must not make it by implication.
    expect(copy).not.toMatch(/until you (confirm|verify)|cannot (use|access)|account is locked/i);
  });

  it('varies exactly one paragraph on isResend', () => {
    const branches = [...copy.matchAll(/\{\{#if isResend\}\}/g)];
    // Two: one in the MJML, one in the text part. More would mean the
    // resend case had started to drift into a separate message.
    expect(branches).toHaveLength(2);
  });

  it('uses one subject for both cases', () => {
    expect(seed.subject).not.toContain('{{#if');
  });
});
