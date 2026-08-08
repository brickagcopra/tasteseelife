import { defaultSchema } from 'rehype-sanitize';

/**
 * The single, centralized allow-list schema for rendering authored CMS content
 * (ADR-0004 §3/§4). Every surface that renders a content `body` — the web-admin
 * authoring preview, and (later) the web-family in-app help + web-marketing blog
 * / legal pages — MUST render through `ContentMarkdown`, which applies THIS
 * schema. Keeping the allow-list in one place means there is exactly one thing to
 * audit and evolve.
 *
 * Security posture (ADR-0004 §3): authored content is UNTRUSTED at render. We
 * build on `rehype-sanitize`'s `defaultSchema` (the GitHub allow-list — strips
 * `<script>`, `<style>`, `<iframe>`, every `on*` handler, and unknown tags) and
 * make it only *narrower plus two safe additions*:
 *
 *   - `href`/`src` protocols are restricted to http/https/mailto (no `javascript:`,
 *     no `data:` URIs) — this is `defaultSchema`'s posture, pinned explicitly here.
 *   - `<a>` may carry `rel` + `target` so `ContentMarkdown` can force
 *     `rel="noopener noreferrer"` on links (the render component sets the value;
 *     the schema merely permits the attribute to survive sanitization).
 *
 * NOTE: `ContentMarkdown` never enables `rehype-raw`, so raw HTML embedded in the
 * Markdown is treated as literal text and escaped BEFORE this schema ever runs —
 * this schema is the second, defence-in-depth layer, not the only one.
 */
export const contentSanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'rel', 'target'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};
