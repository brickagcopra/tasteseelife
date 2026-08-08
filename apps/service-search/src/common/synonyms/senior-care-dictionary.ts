import { type CompiledSynonymGroup, compileSynonymGroups } from './synonym-expander';

/**
 * Curated senior-care + culinary synonym dictionary (TS-216).
 *
 * **Source of truth.** These groups are the canonical dictionary. The
 * Solr-format artifact at `infra/elasticsearch/synonyms/senior-care.txt`
 * is GENERATED from this constant via `serializeSynonymGroupsToSolr` and
 * kept byte-identical by the drift test in `senior-care-dictionary.test.ts`
 * (the openapi-generate pattern: TS source → committed artifact → CI
 * drift gate). The `.txt` is what the live ES synonym token filter loads
 * directly (TS-216-followup-1); Phase-1 service-search consumes the
 * compiled `SENIOR_CARE_SYNONYM_INDEX` for in-memory query expansion.
 *
 * **Each group is an equivalence set** of lowercase phrases. Multi-word
 * phrases (`memory care`) are tokenized at compile time; a search firing
 * any member injects the group's other members' tokens (see
 * `expandQueryTokens` — phrase-containment + stopword guard keep generic
 * words from over-matching). PRD §6.3 cites "dementia" ↔ "memory care"
 * and "kosher" ↔ "religious dietary" as the canonical examples.
 *
 * **Editing.** Edit a group, then regenerate the `.txt`:
 * `serializeSynonymGroupsToSolr(SENIOR_CARE_SYNONYM_GROUPS)` → write the
 * result to `infra/elasticsearch/synonyms/senior-care.txt`. The drift
 * test fails until they match.
 *
 * Cross-reference: the recommendations `DEMENTIA_SPECIALTY_TAGS` set
 * (TS-213) overlaps the cognitive group below. Merging both into one
 * taxonomy is TS-216-followup-2 / TS-213-followup-5.
 */
export const SENIOR_CARE_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // ── Senior-care / cognitive vocabulary ──────────────────────────────
  ['dementia', 'memory care', 'alzheimers', 'cognitive decline', 'cognitive impairment'],
  ['companion', 'companionship', 'companion dining', 'social visit'],
  ['caregiver', 'caregiving', 'care companion'],

  // ── Religious dietary ───────────────────────────────────────────────
  // "religious dietary" is the PRD umbrella term; it sits in both the
  // kosher and halal groups so a search for it surfaces either, without
  // bridging kosher and halal to each other (they stay separate groups).
  ['kosher', 'kashrut', 'religious dietary'],
  ['halal', 'religious dietary'],

  // ── Medical / texture-modified diets ────────────────────────────────
  ['gluten free', 'celiac', 'gluten intolerant'],
  ['vegetarian', 'plant based'],
  ['vegan'],
  ['diabetic', 'diabetes', 'diabetic friendly', 'low sugar'],
  ['low sodium', 'low salt', 'heart healthy'],
  ['pureed', 'soft food', 'texture modified', 'dysphagia'],
  ['lactose free', 'dairy free'],
  ['nut free', 'allergy friendly'],

  // ── Cuisine vocabulary ──────────────────────────────────────────────
  ['italian', 'tuscan', 'sicilian'],
  ['chinese', 'cantonese', 'szechuan', 'sichuan'],
  ['jewish', 'ashkenazi', 'jewish cuisine'],
  ['southern', 'soul food'],
  ['mediterranean', 'greek'],
  ['mexican', 'tex mex'],
  ['indian', 'south asian'],
  ['comfort food', 'home cooking', 'home cooked'],
];

/**
 * The compiled dictionary the in-memory search backend uses for
 * query-time expansion. Compiled once at module load (the groups are
 * static). Single-member groups (e.g. `vegan`) compile to nothing and
 * are dropped by `compileSynonymGroups` — they exist only so the `.txt`
 * documents the canonical term.
 */
export const SENIOR_CARE_SYNONYM_INDEX: readonly CompiledSynonymGroup[] = compileSynonymGroups(
  SENIOR_CARE_SYNONYM_GROUPS,
);

/**
 * Header comment lines prepended to the generated `.txt`. Solr synonym
 * files treat `#`-prefixed lines as comments, so this is safe to load
 * into an ES synonym token filter verbatim.
 */
export const SENIOR_CARE_SYNONYMS_SOLR_HEADER_LINES: readonly string[] = [
  '# Taste & See — senior-care + culinary synonym dictionary (TS-216)',
  '# Solr / Elasticsearch synonym format: comma-separated equivalent terms, one group per line.',
  '#',
  '# GENERATED ARTIFACT — do not hand-edit. Source of truth:',
  '#   apps/service-search/src/common/synonyms/senior-care-dictionary.ts',
  '# Regenerate: write serializeSynonymGroupsToSolr(SENIOR_CARE_SYNONYM_GROUPS) here.',
  '#',
  '# Phase 1 (TS-216): consumed in-memory by service-search query-time expansion.',
  '# Live ES synonym token filter application (provider + content indices) is TS-216-followup-1.',
];

/**
 * Serialize equivalence groups to Solr synonym format: header comment
 * block, a blank line, then one comma-separated group per line, trailing
 * newline. Deterministic — the drift test compares this output to the
 * committed `.txt` byte-for-byte.
 */
export function serializeSynonymGroupsToSolr(groups: readonly (readonly string[])[]): string {
  const header = SENIOR_CARE_SYNONYMS_SOLR_HEADER_LINES.join('\n');
  const body = groups.map((group) => group.join(', ')).join('\n');
  return `${header}\n\n${body}\n`;
}
