import { seniorModeOverrides, seniorModePalette } from './senior-mode';
import {
  breakpointsPx,
  containerMaxPx,
  fontFamilies,
  interactive,
  motion,
  palette,
  radiiRem,
  shadows,
  spacingRem,
} from './tokens';

const indent = (line: string): string => `  ${line}`;
const decl = (name: string, value: string): string => `--${name}: ${value};`;
const remDecl = (name: string, v: number): string => decl(name, v === 0 ? '0' : `${v}rem`);

/**
 * Build the canonical `:root` + `[data-senior-mode='on']` + reduced-motion
 * CSS-variable block. Consumers either paste this into their global CSS or
 * `import '@taste-and-see/design-tokens/styles/tokens.css'` (the
 * pre-rendered output of this generator). The `css.test.ts` drift test
 * keeps the static file aligned with the generator.
 */
export function buildTokenCss(): string {
  return `${rootRule()}\n\n${seniorModeRule()}\n${reducedMotionFallback()}\n`;
}

function rootRule(): string {
  const lines: string[] = [];

  lines.push('  /* Earthy-textile palette (Clay & Linen — design default) */');
  for (const [k, v] of Object.entries(palette)) {
    lines.push(indent(decl(k, v)));
  }

  lines.push('', '  /* Type families */');
  lines.push(indent(decl('serif', fontFamilies.serif)));
  lines.push(indent(decl('sans', fontFamilies.sans)));
  lines.push(indent(decl('mono', fontFamilies.mono)));

  lines.push('', '  /* Spacing (rem) */');
  for (const [k, v] of Object.entries(spacingRem)) {
    lines.push(indent(remDecl(`space-${k}`, v)));
  }

  lines.push('', '  /* Radii (rem) — `full` is 9999px */');
  for (const [k, v] of Object.entries(radiiRem)) {
    lines.push(indent(k === 'full' ? decl(`radius-${k}`, '9999px') : remDecl(`radius-${k}`, v)));
  }

  lines.push('', '  /* Shadows */');
  for (const [k, v] of Object.entries(shadows)) {
    lines.push(indent(decl(`shadow-${k}`, v)));
  }

  lines.push('', '  /* Motion — `--ts-motion-multiplier` is the senior-mode hinge */');
  lines.push(indent(decl('ts-motion-multiplier', '1')));
  for (const [k, v] of Object.entries(motion.durationMs)) {
    lines.push(indent(decl(`duration-${k}`, `calc(${v}ms * var(--ts-motion-multiplier))`)));
  }
  for (const [k, v] of Object.entries(motion.easing)) {
    lines.push(indent(decl(`ease-${k}`, v)));
  }

  lines.push('', '  /* Type scale — `--ts-text-scale` is the senior-mode hinge */');
  lines.push(indent(decl('ts-text-scale', '1')));

  lines.push('', '  /* Layout */');
  lines.push(indent(decl('container-max', `${containerMaxPx}px`)));
  for (const [k, v] of Object.entries(breakpointsPx)) {
    lines.push(indent(decl(`breakpoint-${k}`, `${v}px`)));
  }

  lines.push('', '  /* Interactive sizing */');
  lines.push(indent(remDecl('tap-target-min', interactive.tapTargetMinRem)));
  lines.push(indent(remDecl('focus-ring-width', interactive.focusRingWidthRem)));
  lines.push(indent(remDecl('focus-ring-offset', interactive.focusRingOffsetRem)));

  return `:root {\n${lines.join('\n')}\n}`;
}

function seniorModeRule(): string {
  const lines: string[] = [];

  lines.push('  /* Senior-mode AAA contrast pair (CLAUDE §8.3) */');
  for (const [k, v] of Object.entries(seniorModePalette)) {
    lines.push(indent(decl(k, v)));
  }

  lines.push('', '  /* Senior-mode hinges */');
  lines.push(indent(decl('ts-text-scale', String(seniorModeOverrides.textScale))));
  lines.push(indent(remDecl('tap-target-min', seniorModeOverrides.tapTargetMinRem)));
  lines.push(indent(remDecl('focus-ring-width', seniorModeOverrides.focusRingWidthRem)));
  lines.push(
    indent(decl('ts-motion-multiplier', String(seniorModeOverrides.motionDurationMultiplier))),
  );

  return `[data-senior-mode='on'] {\n${lines.join('\n')}\n}`;
}

function reducedMotionFallback(): string {
  return [
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    '    --ts-motion-multiplier: 0;',
    '  }',
    '}',
  ].join('\n');
}

/**
 * JS-side mirror for code that needs a number rather than a CSS variable
 * (e.g. setTimeout durations matching CSS transitions).
 */
export function motionDurationMs(
  key: keyof typeof motion.durationMs,
  options: { seniorMode?: boolean } = {},
): number {
  const base = motion.durationMs[key];
  return options.seniorMode === true ? base * seniorModeOverrides.motionDurationMultiplier : base;
}
