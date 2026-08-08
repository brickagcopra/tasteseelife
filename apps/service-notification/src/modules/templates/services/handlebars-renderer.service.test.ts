import { describe, expect, it, beforeEach } from 'vitest';

import { HandlebarsRendererService } from './handlebars-renderer.service';

describe('HandlebarsRendererService', () => {
  let svc: HandlebarsRendererService;

  beforeEach(() => {
    svc = new HandlebarsRendererService();
  });

  // ─── HTML escape mode ────────────────────────────────────────────────

  it('substitutes a string variable with HTML escaping in html mode', () => {
    const result = svc.render({
      source: 'Hi {{firstName}}',
      variables: { firstName: 'Alice' },
      escapeMode: 'html',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Hi Alice');
    }
  });

  it('escapes HTML-meaningful characters when the variable contains them (html mode)', () => {
    const result = svc.render({
      source: '<p>{{firstName}}</p>',
      variables: { firstName: '<script>alert(1)</script>' },
      escapeMode: 'html',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toContain('&lt;script&gt;');
      expect(result.output).not.toContain('<script>');
    }
  });

  it('honours triple-stash {{{ }}} for raw (no-escape) substitution in html mode', () => {
    const result = svc.render({
      source: '<p>{{{rawHtml}}}</p>',
      variables: { rawHtml: '<strong>bold</strong>' },
      escapeMode: 'html',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('<p><strong>bold</strong></p>');
    }
  });

  // ─── Text escape mode ────────────────────────────────────────────────

  it('does not escape variables in text mode', () => {
    const result = svc.render({
      source: 'Your code is {{code}}.',
      variables: { code: 'A&B<C' },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Your code is A&B<C.');
    }
  });

  // ─── Variable types ──────────────────────────────────────────────────

  it('substitutes a number variable', () => {
    const result = svc.render({
      source: 'Balance: {{balance}}',
      variables: { balance: 42 },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Balance: 42');
    }
  });

  it('substitutes a boolean variable', () => {
    const result = svc.render({
      source: 'Verified: {{verified}}',
      variables: { verified: true },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Verified: true');
    }
  });

  it('renders an unknown variable as the empty string (Handlebars default, defence-in-depth — the VariableValidator catches first)', () => {
    const result = svc.render({
      source: 'Hi {{missingVar}}',
      variables: {},
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Hi ');
    }
  });

  // ─── Built-in block helpers (compile-time inlined, safe under the
  // ─── upstream variable validator's primitive-only constraint) ───────

  it('allows the built-in {{#if}} block helper (compile-time inlined)', () => {
    const result = svc.render({
      source: '{{#if verified}}Yes{{else}}No{{/if}}',
      variables: { verified: true },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.output).toBe('Yes');
    }
  });

  it('rejects a call to a custom helper because knownHelpersOnly + empty knownHelpers locks it out', () => {
    // `myHelper` is not a built-in block helper and not in
    // `knownHelpers` — the compiler should refuse to emit a call to it.
    const result = svc.render({
      source: '{{myHelper foo}}',
      variables: { foo: 'bar' },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('failed');
  });

  // ─── Prototype-access lockout ───────────────────────────────────────

  it('does not allow access to Object.prototype properties', () => {
    const result = svc.render({
      source: '{{constructor}}',
      variables: { foo: 'bar' },
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      // Handlebars 4.6+ blocks prototype access by default; the
      // substitution renders as the empty string.
      expect(result.output).toBe('');
    }
  });

  // ─── Parse failures ──────────────────────────────────────────────────

  it('returns failed when the template source is syntactically invalid', () => {
    const result = svc.render({
      source: '{{unclosed',
      variables: {},
      escapeMode: 'text',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  // ─── Determinism ─────────────────────────────────────────────────────

  it('produces the same output for two identical calls (deterministic, no cross-call state)', () => {
    const input = {
      source: 'Hi {{name}}, your balance is {{balance}}.',
      variables: { name: 'Alice', balance: 100 },
      escapeMode: 'text' as const,
    };
    const a = svc.render(input);
    const b = svc.render(input);
    expect(a.outcome).toBe('ok');
    expect(b.outcome).toBe('ok');
    if (a.outcome === 'ok' && b.outcome === 'ok') {
      expect(a.output).toBe(b.output);
    }
  });
});
