import { describe, expect, it } from 'vitest';

import {
  type CompiledSynonymGroup,
  SYNONYM_EXPANSION_STOPWORDS,
  compileSynonymGroups,
  expandQueryTokens,
  tokenizeText,
} from './synonym-expander';

describe('tokenizeText', () => {
  it('lowercases and splits on non-alphanumeric runs', () => {
    expect(tokenizeText('Memory-Care')).toEqual(['memory', 'care']);
    expect(tokenizeText('dementia_sensitive')).toEqual(['dementia', 'sensitive']);
    expect(tokenizeText('Tex Mex')).toEqual(['tex', 'mex']);
  });

  it('drops empty tokens from leading / trailing / repeated separators', () => {
    expect(tokenizeText('  italian , , tuscan  ')).toEqual(['italian', 'tuscan']);
    expect(tokenizeText('!!!')).toEqual([]);
    expect(tokenizeText('')).toEqual([]);
  });

  it('keeps digits', () => {
    expect(tokenizeText('omega 3 diet')).toEqual(['omega', '3', 'diet']);
  });
});

describe('compileSynonymGroups', () => {
  it('tokenizes each member and computes the deduped union', () => {
    const [group] = compileSynonymGroups([['memory care', 'dementia', 'memory loss']]);
    expect(group?.members).toEqual([['memory', 'care'], ['dementia'], ['memory', 'loss']]);
    // union dedupes the shared `memory` token across two members
    expect(group?.allTokens).toEqual(['memory', 'care', 'dementia', 'loss']);
  });

  it('drops groups with fewer than two non-empty members (nothing to expand)', () => {
    expect(compileSynonymGroups([['vegan']])).toEqual([]);
    // a member that tokenizes to nothing does not count toward the floor
    expect(compileSynonymGroups([['kosher', '!!!']])).toEqual([]);
  });

  it('keeps a group once it has two real members', () => {
    expect(compileSynonymGroups([['kosher', 'kashrut']])).toHaveLength(1);
  });
});

describe('expandQueryTokens', () => {
  const fixture: readonly CompiledSynonymGroup[] = compileSynonymGroups([
    ['dementia', 'memory care', 'alzheimers'],
    ['kosher', 'kashrut', 'religious dietary'],
  ]);

  it('preserves literal tokens verbatim and in input order', () => {
    expect(expandQueryTokens(['private', 'chef'], fixture)).toEqual(['private', 'chef']);
  });

  it('fires on a multi-word member fully present (phrase containment)', () => {
    const out = expandQueryTokens(['memory', 'care'], fixture);
    expect(out.slice(0, 2)).toEqual(['memory', 'care']);
    expect(out).toContain('dementia');
    expect(out).toContain('alzheimers');
  });

  it('does NOT fire on a single generic token of a multi-word member', () => {
    // "care" alone never pulls in "dementia" — the member "memory care"
    // is not fully present, so the group does not fire.
    expect(expandQueryTokens(['care'], fixture)).toEqual(['care']);
  });

  it('expands a single-token member to the rest of its group', () => {
    const out = expandQueryTokens(['dementia'], fixture);
    expect(out).toContain('memory');
    expect(out).toContain('alzheimers');
  });

  it('skips stopwords when injecting (but keeps them as triggers)', () => {
    // "religious dietary" fires the kosher group; `dietary` is a stopword
    // so it is NOT injected, but `kosher` / `kashrut` are.
    const out = expandQueryTokens(['religious', 'dietary'], fixture);
    expect(out).toContain('kosher');
    expect(out).toContain('kashrut');
    // literal `religious` + `dietary` stay; no other stopword leaks in
    expect(out.filter((t) => t === 'dietary')).toEqual(['dietary']);
    expect(out).toContain('religious');
  });

  it('keeps a literal stopword the user actually typed', () => {
    expect(expandQueryTokens(['care'], fixture, SYNONYM_EXPANSION_STOPWORDS)).toEqual(['care']);
  });

  it('is single-pass — injected tokens do not re-trigger other groups', () => {
    // Build a chain a → b, b → c. Firing the first group injects `b`,
    // but `b` must not then fire the second group.
    const chain = compileSynonymGroups([
      ['alpha', 'bravo'],
      ['bravo', 'charlie'],
    ]);
    const out = expandQueryTokens(['alpha'], chain);
    expect(out).toContain('bravo');
    expect(out).not.toContain('charlie');
  });

  it('dedupes — no token appears twice even across overlapping groups', () => {
    const overlapping = compileSynonymGroups([
      ['halal', 'religious dietary'],
      ['kosher', 'religious dietary'],
    ]);
    // Both groups share the `religious` token; firing both must not
    // duplicate it. (`dietary` is a stopword, never injected anyway.)
    const out = expandQueryTokens(['religious', 'dietary'], overlapping);
    const counts = new Map<string, number>();
    for (const t of out) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [, count] of counts) expect(count).toBe(1);
    expect(out).toContain('halal');
    expect(out).toContain('kosher');
  });

  it('returns an empty array for an empty / punctuation-only query', () => {
    expect(expandQueryTokens([], fixture)).toEqual([]);
  });
});
