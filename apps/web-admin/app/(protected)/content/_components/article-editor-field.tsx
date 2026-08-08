'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Client boundary that lazy-loads the TipTap `ArticleEditor` with `ssr: false`
 * (ADR-0004 §1 — the editor touches the DOM and must never render on the server).
 * Server components (`new`/edit pages) render THIS field; the heavy editor chunk
 * is code-split and only fetched on the authoring routes.
 *
 * The `loading` fallback is a plain named `<textarea>` so the form is usable (and
 * carries `name`) before the editor hydrates.
 */
const ArticleEditor = dynamic(() => import('./article-editor'), {
  ssr: false,
  loading: () => (
    <textarea
      className="content-editor__markdown"
      name="__editor_loading"
      aria-label="Loading editor…"
      placeholder="Loading editor…"
      rows={18}
      disabled
    />
  ),
});

export function ArticleEditorField({
  name,
  defaultValue,
}: {
  readonly name: string;
  readonly defaultValue?: string;
}): React.JSX.Element {
  return <ArticleEditor name={name} defaultValue={defaultValue ?? ''} />;
}
