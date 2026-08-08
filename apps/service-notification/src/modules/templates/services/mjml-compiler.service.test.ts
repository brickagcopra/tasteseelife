import { describe, expect, it, beforeEach } from 'vitest';

import { MjmlCompilerService } from './mjml-compiler.service';

describe('MjmlCompilerService', () => {
  let svc: MjmlCompilerService;

  beforeEach(() => {
    svc = new MjmlCompilerService();
  });

  it('compiles a minimal well-formed MJML document', () => {
    const source = `<mjml>
      <mj-body>
        <mj-section>
          <mj-column>
            <mj-text>Hello, world.</mj-text>
          </mj-column>
        </mj-section>
      </mj-body>
    </mjml>`;
    const result = svc.compile(source);
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.html).toContain('Hello, world.');
      expect(
        result.html.startsWith('<!doctype html>') || result.html.startsWith('<!DOCTYPE html>'),
      ).toBe(true);
    }
  });

  it('preserves a Handlebars expression in the compiled output (round-trips through MJML untouched)', () => {
    const source = `<mjml>
      <mj-body>
        <mj-section>
          <mj-column>
            <mj-text>Hi {{firstName}}</mj-text>
          </mj-column>
        </mj-section>
      </mj-body>
    </mjml>`;
    const result = svc.compile(source);
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.html).toContain('{{firstName}}');
    }
  });

  it('fails on an unknown MJML tag under strict validation', () => {
    const source = `<mjml><mj-body><mj-not-a-real-tag /></mj-body></mjml>`;
    const result = svc.compile(source);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.errors.length).toBeGreaterThan(0);
      // mjml's strict-mode error message includes the tag name.
      expect(result.errors.some((e) => /not-a-real-tag/i.test(e.message))).toBe(true);
    }
  });

  it('never throws on malformed input — failures land in the failed outcome', () => {
    // mjml's parser is lenient with unclosed tags (it auto-closes),
    // so the contract guarantee tested here is "never throws",
    // independent of which outcome lands. Strict-mode validation
    // failures are covered separately by the unknown-tag test above.
    const ill = `<mjml><mj-body><mj-section><mj-column><mj-text>oops`;
    expect(() => svc.compile(ill)).not.toThrow();
  });

  it('does not honour mj-include — the include tag is ignored at compile time', () => {
    // mj-include with ignoreIncludes: true compiles to empty content
    // without reading the file path. The output should NOT contain
    // any references to the requested path.
    const source = `<mjml><mj-body><mj-include path="/etc/passwd" /></mj-body></mjml>`;
    const result = svc.compile(source);
    // Either succeeds with the include scrubbed, or fails strict
    // validation — both outcomes confirm the file is never read.
    if (result.outcome === 'ok') {
      expect(result.html).not.toContain('/etc/passwd');
      expect(result.html).not.toContain('root:');
    }
  });

  it('returns the same HTML for two identical inputs (deterministic)', () => {
    const source = `<mjml><mj-body><mj-section><mj-column><mj-text>X</mj-text></mj-column></mj-section></mj-body></mjml>`;
    const a = svc.compile(source);
    const b = svc.compile(source);
    expect(a.outcome).toBe('ok');
    expect(b.outcome).toBe('ok');
    if (a.outcome === 'ok' && b.outcome === 'ok') {
      expect(a.html).toBe(b.html);
    }
  });
});
