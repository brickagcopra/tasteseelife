import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

import { cn } from '../lib/cn';
import { contentSanitizeSchema } from '../lib/content-sanitize-schema';

export interface ContentMarkdownProps {
  /** The canonical Markdown body (ADR-0004 §2 — Markdown is the at-rest form). */
  readonly markdown: string;
  /** Optional wrapper class (merged last-wins). */
  readonly className?: string;
}

/**
 * ContentMarkdown — the ONE safe renderer for authored CMS content (ADR-0004
 * §3/§4). Renders canonical Markdown to React elements via `react-markdown`
 * (GFM enabled) and applies the centralized allow-list `contentSanitizeSchema`.
 *
 * Untrusted-at-render by construction:
 *   - NO `rehype-raw` → raw HTML in the Markdown is escaped to literal text, not
 *     parsed into live nodes.
 *   - NO `dangerouslySetInnerHTML` anywhere.
 *   - `rehype-sanitize` strips anything outside the allow-list as a second layer.
 *
 * Every anchor is forced to `rel="noopener noreferrer"`; links that resolve to an
 * absolute http(s) URL also open in a new tab. A careless or compromised author
 * therefore cannot land stored XSS or a reverse-tabnabbing vector.
 *
 * Styling is left to the consumer's stylesheet targeting `.content-markdown …`
 * (web-admin hand-CSS today; a Tailwind `prose`-style consumer later) so the same
 * component serves both the Tailwind and non-Tailwind surfaces named in ADR-0004.
 */
export function ContentMarkdown({ markdown, className }: ContentMarkdownProps): React.JSX.Element {
  return (
    <div className={cn('content-markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, contentSanitizeSchema]]}
        components={{
          a({ node: _node, href, children, ...props }) {
            const external = typeof href === 'string' && /^https?:\/\//i.test(href);
            return (
              <a
                {...props}
                href={href}
                rel="noopener noreferrer"
                {...(external ? { target: '_blank' } : {})}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
