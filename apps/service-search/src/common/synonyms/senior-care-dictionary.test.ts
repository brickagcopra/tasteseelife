import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SENIOR_CARE_SYNONYM_GROUPS,
  SENIOR_CARE_SYNONYM_INDEX,
  serializeSynonymGroupsToSolr,
} from './senior-care-dictionary';

// apps/service-search/src/common/synonyms → repo root is five levels up.
const ARTIFACT_PATH = resolve(
  __dirname,
  '../../../../../infra/elasticsearch/synonyms/senior-care.txt',
);

describe('serializeSynonymGroupsToSolr', () => {
  it('renders header, blank line, comma-joined groups, and a trailing newline', () => {
    const out = serializeSynonymGroupsToSolr([['kosher', 'kashrut'], ['halal']]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('# Taste & See — senior-care + culinary synonym dictionary (TS-216)');
    // header block, then a blank line, then the two group lines
    expect(out).toContain('\n\nkosher, kashrut\nhalal\n');
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('senior-care.txt drift', () => {
  it('matches the serialized TS source of truth byte-for-byte', () => {
    const committed = readFileSync(ARTIFACT_PATH, 'utf8');
    const expected = serializeSynonymGroupsToSolr(SENIOR_CARE_SYNONYM_GROUPS);
    // If this fails: rewrite infra/elasticsearch/synonyms/senior-care.txt
    // with serializeSynonymGroupsToSolr(SENIOR_CARE_SYNONYM_GROUPS).
    expect(committed).toBe(expected);
  });
});

describe('SENIOR_CARE_SYNONYM_GROUPS', () => {
  it('carries only lowercase, non-empty, comma-free phrases', () => {
    for (const group of SENIOR_CARE_SYNONYM_GROUPS) {
      expect(group.length).toBeGreaterThan(0);
      for (const member of group) {
        expect(member.length).toBeGreaterThan(0);
        expect(member).toBe(member.toLowerCase());
        // commas are the group separator in Solr format — never inside a member
        expect(member).not.toContain(',');
        expect(member.trim()).toBe(member);
      }
    }
  });

  it('encodes the PRD §6.3 canonical examples', () => {
    const flat = SENIOR_CARE_SYNONYM_GROUPS.map((g) => new Set(g));
    // "dementia" ↔ "memory care"
    expect(flat.some((g) => g.has('dementia') && g.has('memory care'))).toBe(true);
    // "kosher" ↔ "religious dietary"
    expect(flat.some((g) => g.has('kosher') && g.has('religious dietary'))).toBe(true);
  });
});

describe('SENIOR_CARE_SYNONYM_INDEX', () => {
  it('drops single-member groups (nothing to expand) but keeps every multi-member group', () => {
    const multiMemberGroups = SENIOR_CARE_SYNONYM_GROUPS.filter((g) => g.length >= 2);
    expect(SENIOR_CARE_SYNONYM_INDEX).toHaveLength(multiMemberGroups.length);
    for (const compiled of SENIOR_CARE_SYNONYM_INDEX) {
      expect(compiled.members.length).toBeGreaterThanOrEqual(2);
      expect(compiled.allTokens.length).toBeGreaterThan(0);
    }
  });
});
