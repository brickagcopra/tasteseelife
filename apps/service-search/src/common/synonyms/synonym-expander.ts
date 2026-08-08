/**
 * Query-time synonym expansion for the senior-care + culinary vocabulary
 * (TS-216). Pure + dependency-free so it ships unchanged into the live
 * Elasticsearch wiring (TS-216-followup-1) and a future shared package
 * (TS-216-followup-2).
 *
 * **Why query-time, not index-time.** Expanding the *query* (not the
 * stored doc) mirrors an ES `synonym_graph` token filter on the search
 * analyzer: the index stays the literal provider vocabulary, and a
 * search for "memory care" widens to also match docs tagged `dementia`.
 * The Phase-1 token-overlap backend (`in-memory-search-backend.service`)
 * expands the query token set here before the overlap check; the live ES
 * path will load the same dictionary into a synonym token filter.
 *
 * **Phrase-containment, not naive token mapping.** A group like
 * `[dementia, memory care, alzheimers]` must NOT make a bare "care"
 * query pull in "dementia" — "care" is a generic word. So a group only
 * fires when one of its *members* is fully present in the query token
 * set (every token of "memory care" present), at which point the OTHER
 * members' tokens are injected. This keeps single generic tokens inert
 * while still expanding genuine multi-word concepts.
 *
 * **Stopword guard on injected tokens.** Even a fired group must not
 * inject generic words (`care`, `dietary`, `free`, …) as standalone
 * match tokens, or "kosher" → "religious dietary" would match every
 * provider whose bio merely says "dietary". Stopwords still participate
 * in phrase-trigger detection (so the multi-word member is detectable),
 * but are never *added* to the expanded set. Literal user tokens are
 * always kept verbatim — the stopword guard only filters synonym-
 * injected tokens, never what the user actually typed.
 */

/**
 * Generic words that may appear in a synonym phrase but must never be
 * injected as a standalone match token. Kept deliberately small: only
 * words common enough across provider bios / tags to cause real
 * over-matching when injected by expansion. Discriminating words
 * (`gluten`, `sodium`, `kosher`, …) are intentionally absent.
 */
export const SYNONYM_EXPANSION_STOPWORDS: ReadonlySet<string> = new Set<string>([
  'care',
  'dietary',
  'diet',
  'food',
  'foods',
  'meal',
  'meals',
  'cooking',
  'cuisine',
  'home',
  'based',
  'friendly',
  'free',
  'service',
  'services',
]);

/**
 * Split text into lowercase alphanumeric tokens. This is the single
 * tokenizer for the search relevance path — the in-memory backend's
 * haystack tokenization and the synonym expander share it so the query
 * and doc token universes always agree. Mirrors an ES lowercase +
 * standard tokenizer chain closely enough for the Phase-1 heuristic.
 */
export function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** A synonym group compiled once: per-member token arrays + the deduped union. */
export interface CompiledSynonymGroup {
  /** Each equivalence-group member, tokenized (e.g. `['memory','care']`). */
  readonly members: readonly (readonly string[])[];
  /** Union of every member's tokens, deduped — the candidate injection set. */
  readonly allTokens: readonly string[];
}

/**
 * Compile the raw equivalence groups (human phrases) into the token-level
 * shape `expandQueryTokens` consumes. Empty members and groups with fewer
 * than two non-empty members are dropped — a group of one expands nothing.
 */
export function compileSynonymGroups(
  groups: readonly (readonly string[])[],
): CompiledSynonymGroup[] {
  const compiled: CompiledSynonymGroup[] = [];
  for (const group of groups) {
    const members = group.map((member) => tokenizeText(member)).filter((m) => m.length > 0);
    if (members.length < 2) continue;
    const union = new Set<string>();
    for (const member of members) {
      for (const token of member) union.add(token);
    }
    compiled.push({ members, allTokens: [...union] });
  }
  return compiled;
}

/**
 * Expand a query's token set with synonyms. Returns the original tokens
 * (verbatim, in input order) followed by any injected synonym tokens.
 *
 * A group fires when at least one member's tokens are *all* present in
 * the original query tokens (phrase containment). On firing, the group's
 * union tokens are appended, skipping (a) tokens already present and
 * (b) stopwords. Single-pass: injected tokens never trigger further
 * expansion, so the result is bounded and deterministic.
 */
export function expandQueryTokens(
  tokens: readonly string[],
  compiled: readonly CompiledSynonymGroup[],
  stopwords: ReadonlySet<string> = SYNONYM_EXPANSION_STOPWORDS,
): string[] {
  const present = new Set(tokens);
  const out: string[] = [...tokens];
  const seen = new Set(tokens);

  for (const group of compiled) {
    const fired = group.members.some(
      (member) => member.length > 0 && member.every((token) => present.has(token)),
    );
    if (!fired) continue;
    for (const token of group.allTokens) {
      if (seen.has(token)) continue;
      if (stopwords.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }

  return out;
}
