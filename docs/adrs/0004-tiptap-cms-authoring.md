# ADR-0004 — Rich-text CMS authoring: TipTap editor + Markdown-canonical storage + allow-list render sanitization

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Product / Engineering (owner: brickagcopra)
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** TS-281 (blog admin UI — dual-mode WYSIWYG + Markdown authoring); unblocks TS-282 / TS-283 (author-facing editing surfaces) and the render half of TS-284-followup-1 (public legal-page rendering)

---

## Context

The `service-content` bounded context now has its full authenticated write surface
(TS-280 skeleton → TS-284 pages → TS-284-followup-3 articles + help-categories):
pages / page_versions / articles / article_versions / help_categories, each
version carrying a `body`, with draft → publish (`effective_at` + `current_version_id`)
semantics and transactional audit. What does **not** exist is any authoring UI —
TS-281 requires a **dual-mode WYSIWYG + Markdown** editor in `web-admin` so content
staff can write blog posts, help articles, and static legal pages.

CLAUDE.md §13's frontend approved-libraries list carries no rich-text editor.
CLAUDE.md §13/§16 require an ADR before adopting an off-list library. TS-281's own
acceptance note flags this explicitly: "TipTap requires an ADR before adopting."

Two coupled decisions fall out of "add an editor": (1) the editor library itself,
and (2) the **canonical at-rest representation** of authored content — which in turn
forces a (3) **rendering + sanitization** decision, because authored content is
eventually rendered to end users (families, seniors, the public marketing site) and
un-sanitized rich content is a stored-XSS vector. CLAUDE.md §3.8 already codifies the
platform's stance — "never directly render LLM output as HTML" — and the same
discipline applies to human-authored CMS content: **content is untrusted at render.**

## Decision

### 1. Editor: the TipTap family (`@tiptap/*` + `tiptap-markdown`)

Add to the CLAUDE.md §13 frontend approved list:

- `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` — the core headless editor.
- `@tiptap/extension-*` (link, placeholder, image, etc.) **as needed** — same family,
  no separate ADR per extension.
- `tiptap-markdown` — the Markdown ⇄ ProseMirror-document serialization bridge that
  makes "dual-mode WYSIWYG + Markdown" a single source of truth rather than two
  divergent editors.

TipTap is a headless, framework-native (React 19 compatible), ProseMirror-based
editor. Headless means **we** own the markup and styling — it renders through our
design tokens / `packages/ui` primitives (CLAUDE.md §8.2), not a vendored theme, so
senior-mode contrast + tap-target rules (CLAUDE.md §8.3) are honored. It is
schema-constrained (a document can only contain node/mark types we register), which
is itself a defense-in-depth boundary against arbitrary embedded HTML.

The editor is a **Client Component** (`'use client'`) — it is inherently interactive
and touches `window`/DOM. It is loaded via `next/dynamic` with `ssr: false` so it
never enters the RSC/SSR path (CLAUDE.md §8.1: `'use client'` only when required, and
keep it off the server render). The published _reading_ surfaces stay Server
Components — TipTap ships **only** to the authoring routes in `web-admin`, never to
the family/marketing read surfaces.

### 2. Canonical storage: **Markdown** in `*_version.body`

The at-rest canonical form of authored `body` content is **GitHub-Flavored
Markdown**, stored verbatim in the existing `page_versions.body` /
`article_versions.body` text columns. **No schema/contract change** — `body` is
already free text; this decision fixes its _format contract_ as Markdown.

Rationale:

- **Portable + diffable.** Markdown is plain text: the append-only version history
  (TS-284) produces human-readable diffs, and content is never locked to one editor's
  internal JSON. A future editor swap (see Alternatives) reads the same column.
- **Dual-mode is one source of truth.** TipTap edits a ProseMirror document;
  `tiptap-markdown` serializes to/parses from Markdown on load/save. The "Markdown
  mode" is then just the same canonical string in a `<textarea>` — the two modes can
  never diverge because both round-trip the identical stored Markdown.
- **We never store HTML at rest.** Storing pre-rendered/sanitized HTML is a footgun:
  the sanitization policy can only be re-applied on a re-render, and stored HTML
  invites `dangerouslySetInnerHTML`. Storing Markdown keeps the untrusted-at-render
  posture (decision 3) enforceable on every read.

### 3. Rendering: allow-list sanitized Markdown → HTML (`react-markdown` + `remark-gfm` + `rehype-sanitize`)

Add to the CLAUDE.md §13 frontend approved list:

- `react-markdown` — renders Markdown to React elements (no raw-HTML injection path).
- `remark-gfm` — GFM tables / task-lists / strikethrough / autolinks.
- `rehype-sanitize` — **allow-list** sanitization of the rendered element tree.

**No content `body` is ever rendered via `dangerouslySetInnerHTML`.** All read
surfaces (web-admin preview, web-family in-app help, web-marketing blog/legal) render
through `react-markdown` configured with `rehype-sanitize` against an **explicit
allow-list schema** (a curated extension of the default GitHub schema: headings,
lists, tables, links, emphasis, code, blockquote, images restricted to our own
media/CDN origin). Raw HTML embedded in Markdown is **stripped**, not passed through
(`react-markdown` does not parse raw HTML unless `rehype-raw` is added — and we
deliberately do **not** add `rehype-raw`). This makes authored content
untrusted-at-render by construction (CLAUDE.md §3.8 discipline applied to CMS
content), so a compromised or careless author cannot land stored XSS.

Link handling: rendered links get `rel="noopener noreferrer"`; external links are
visually + a11y-labeled. This is enforced in the shared render component, not
per-call.

### 4. One shared render primitive in `packages/ui`

The sanitized renderer lands once as `packages/ui/src/components/content-markdown.tsx`
(`ContentMarkdown`) with the sanitize schema centralized beside it — so web-admin
preview, web-family, and web-marketing all render content identically and safely, and
the allow-list has exactly one place to audit/evolve. No app re-implements Markdown
rendering.

## Consequences

**Positive**

- TS-281 (and the downstream authoring UIs TS-282/TS-283) is unblocked with a
  React-19-native, design-token-themable, schema-constrained editor.
- Canonical Markdown keeps the TS-284 version history diffable and editor-agnostic;
  the "dual-mode" requirement is satisfied without two divergent editors.
- Stored-XSS is closed off structurally: no HTML at rest, no `dangerouslySetInnerHTML`,
  no `rehype-raw`, allow-list sanitization on every render, centralized in one
  auditable primitive.
- TipTap is confined to `web-admin` authoring routes (client-only, `ssr:false`), so
  the public read surfaces keep their RSC/streaming performance budget (CLAUDE.md §7).

**Negative / deferred**

- New frontend deps (`@tiptap/*`, `tiptap-markdown`, `react-markdown`, `remark-gfm`,
  `rehype-sanitize`) land in `package.json` **only** in the packages that consume them
  (the `web-admin` authoring bundle + `packages/ui` render primitive) — not workspace-
  wide. The web-admin authoring route's bundle-size budget (CLAUDE.md §11 bundle gate)
  is re-checked in the TS-281 PR; TipTap is code-split via `next/dynamic` so it does
  not weigh the non-authoring routes.
- `scheduled-publish` (TS-281 acceptance) needs a publish-at mechanism; the current
  publish endpoint is immediate. A scheduled-publish worker/`publish_at` column is a
  carved TS-281 follow-up, not part of this ADR.
- Article **tags** (TS-281 acceptance) are not in the TS-280 schema (only
  `help_categories` + article `category_id`). A `tags` / `article_tags` additive
  migration is a carved TS-281 follow-up.

## Alternatives considered

- **Lexical (Meta)** — capable and React-native, but a younger ecosystem with a
  thinner Markdown-serialization story and no clear advantage over TipTap for a
  block-based CMS; TipTap's ProseMirror schema-constraint model is a better security
  fit. Rejected.
- **Slate** — lower-level; we'd hand-build toolbar/schema/serialization that
  StarterKit gives us. Rejected (build cost).
- **Plain Markdown `<textarea>` + preview, no WYSIWYG (zero new editor dep)** — the
  cheapest option and genuinely viable, but TS-281 explicitly requires **dual-mode
  WYSIWYG**, and content staff authoring senior-facing help/legal content benefit from
  a formatting-safe visual editor. We keep the Markdown-only mode (it's the canonical
  string in a textarea) as the fallback lane _within_ the dual-mode editor, so this
  option is effectively subsumed rather than discarded.
- **Store TipTap/ProseMirror JSON as canonical** — rejected: locks content to the
  editor, produces opaque version diffs, and complicates non-web rendering (email
  digests, PDF exports). Markdown-canonical keeps the data portable.
- **Store sanitized HTML as canonical** — rejected: re-sanitization can't be re-applied
  on policy change without a migration, and it invites `dangerouslySetInnerHTML`.
  Sanitize on render, not on write.
- **A hosted CMS (Contentful / Sanity.io)** — rejected for Phase 1/2: adds a vendor +
  cost + an external content store outside the tenant-scoped Postgres source of truth,
  for content the platform already models natively in `service-content`.
