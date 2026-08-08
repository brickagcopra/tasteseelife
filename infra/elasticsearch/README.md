# Elasticsearch / OpenSearch assets

Index-time and query-time configuration assets for the search subsystem
(PDD §14). Phase-1 search runs on the pure-TS in-memory backend
(`apps/service-search`); these files are the source assets the live ES
wiring (TS-111-followup-1) loads.

## `synonyms/senior-care.txt`

Curated senior-care + culinary synonym dictionary in Solr synonym format
(comma-separated equivalent terms, one group per line; `#` comments).
PRD §6.3 / PDD §14.2.

**This is a generated artifact.** The source of truth is the TypeScript
constant `SENIOR_CARE_SYNONYM_GROUPS` in
`apps/service-search/src/common/synonyms/senior-care-dictionary.ts`.
Regenerate by writing `serializeSynonymGroupsToSolr(SENIOR_CARE_SYNONYM_GROUPS)`
back to this file; a drift test
(`senior-care-dictionary.test.ts`) fails in CI if the committed `.txt`
and the TS source diverge — mirroring the OpenAPI generate-and-check
pattern (TS-009f).

| Consumer                                      | Status                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| service-search in-memory query-time expansion | **Live (TS-216)** — compiled at module load, expands query tokens before the overlap match |
| Live ES synonym token filter (provider index) | Deferred — **TS-216-followup-1** (pairs with the live ES backend, TS-111-followup-1)       |
| Live ES synonym token filter (content index)  | Deferred — **TS-216-followup-1** (pairs with `service-content`, TS-280)                    |
