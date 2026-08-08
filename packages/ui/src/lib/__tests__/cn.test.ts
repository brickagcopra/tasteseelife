import { describe, expect, it } from 'vitest';

import { cn } from '../cn';

describe('cn', () => {
  it('joins truthy class values', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy values', () => {
    expect(cn('a', null, undefined, false, 'b')).toBe('a b');
  });

  it('respects conditional class objects', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active');
  });

  it('flattens arrays', () => {
    expect(cn(['a', ['b', 'c']])).toBe('a b c');
  });

  it('merges conflicting Tailwind utilities — last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-ink', 'text-paper')).toBe('text-paper');
  });

  it('preserves non-conflicting utilities', () => {
    expect(cn('bg-paper', 'text-ink')).toBe('bg-paper text-ink');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });

  it('keeps width + color rings together (custom group config)', () => {
    // ring-focus is a width token, ring-paper is a color token; both should
    // survive the merge because they're different class groups.
    const out = cn('ring-focus', 'ring-paper');
    expect(out).toContain('ring-focus');
    expect(out).toContain('ring-paper');
  });

  it('still last-wins when two width tokens conflict', () => {
    // ring-2 (stock) and ring-focus (custom) both belong to ring-w.
    expect(cn('ring-2', 'ring-focus')).toBe('ring-focus');
  });

  it('keeps ring-offset width + offset color separately', () => {
    const out = cn('ring-offset-focus', 'ring-offset-paper');
    expect(out).toContain('ring-offset-focus');
    expect(out).toContain('ring-offset-paper');
  });
});
