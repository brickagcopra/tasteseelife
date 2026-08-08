import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildTokenCss } from '../index';

const STATIC_CSS_PATH = resolve(__dirname, '../../styles/tokens.css');

const norm = (s: string): string =>
  s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n');

const stripPreamble = (css: string): string => {
  const firstRule = css.search(/^[:[@]/m);
  return firstRule >= 0 ? css.slice(firstRule) : css;
};

describe('buildTokenCss', () => {
  it('emits `:root`, senior-mode, and reduced-motion blocks', () => {
    const out = buildTokenCss();
    expect(out).toMatch(/^:root \{/);
    expect(out).toContain("[data-senior-mode='on'] {");
    expect(out).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('declares the design palette under :root by their kebab-case names', () => {
    const out = buildTokenCss();
    expect(out).toContain('--paper: #F6F1E7;');
    expect(out).toContain('--linen: #E8DCC4;');
    expect(out).toContain('--linen-2: #D9CBAE;');
    expect(out).toContain('--clay: #C4856B;');
    expect(out).toContain('--clay-deep: #A86A52;');
    expect(out).toContain('--espresso: #3D2E1F;');
  });

  it('declares text-scale and motion-multiplier as the senior-mode hinges', () => {
    const out = buildTokenCss();
    expect(out).toMatch(/--ts-text-scale: 1;/);
    expect(out).toMatch(/--ts-motion-multiplier: 1;/);
    expect(out).toMatch(/--ts-text-scale: 1\.5;/);
    expect(out).toMatch(/--ts-motion-multiplier: 0;/);
  });

  it('flips the palette on `[data-senior-mode=on]`', () => {
    const out = buildTokenCss();
    const seniorBlock = out.slice(out.indexOf("[data-senior-mode='on']"));
    expect(seniorBlock).toContain('--paper: #FFFEFA;');
    expect(seniorBlock).toContain('--ink: #0A0700;');
    expect(seniorBlock).toContain('--tap-target-min: 3rem;');
  });

  it('every motion-duration declaration references --ts-motion-multiplier', () => {
    const out = buildTokenCss();
    for (const k of ['instant', 'fast', 'base', 'slow', 'rise']) {
      expect(out).toMatch(
        new RegExp(`--duration-${k}: calc\\([^)]+\\* var\\(--ts-motion-multiplier\\)\\);`),
      );
    }
  });

  it('is deterministic across calls (drift-detection prerequisite)', () => {
    expect(buildTokenCss()).toBe(buildTokenCss());
  });
});

describe('static styles/tokens.css matches buildTokenCss output', () => {
  it('content matches (whitespace-tolerant; static doc preamble stripped)', () => {
    const generated = norm(buildTokenCss());
    const staticContent = norm(stripPreamble(readFileSync(STATIC_CSS_PATH, 'utf8')));
    expect(staticContent).toBe(generated);
  });
});
