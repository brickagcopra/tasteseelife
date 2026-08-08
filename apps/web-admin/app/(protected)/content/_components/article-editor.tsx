'use client';

import * as React from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';

/**
 * Dual-mode article body editor (TS-281; ADR-0004 §1/§2).
 *
 * The canonical stored form is **Markdown** (ADR-0004 §2). This component lets
 * an author write in either a WYSIWYG surface (TipTap StarterKit + Link) or a
 * raw-Markdown `<textarea>`; BOTH round-trip the same canonical Markdown string
 * via `tiptap-markdown`, so the two modes can never diverge. A single hidden
 * input (`name={name}`) always carries the current canonical Markdown, so the
 * enclosing server-action `<form>` submits Markdown regardless of the active
 * mode.
 *
 * Client-only: it is dynamic-imported with `ssr: false` (see
 * `article-editor-field.tsx`), so it never runs on the server / RSC path. That
 * keeps TipTap out of the shared bundle of the non-authoring admin routes.
 */
export default function ArticleEditor({
  name,
  defaultValue = '',
}: {
  readonly name: string;
  readonly defaultValue?: string;
}): React.JSX.Element {
  const [mode, setMode] = React.useState<'wysiwyg' | 'markdown'>('wysiwyg');
  const [markdown, setMarkdown] = React.useState<string>(defaultValue);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Markdown.configure({ html: false, linkify: true }),
    ],
    content: defaultValue,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'content-editor__surface', 'aria-label': 'Article body (rich text)' },
    },
    onUpdate({ editor: current }) {
      const md: string = current.storage.markdown.getMarkdown();
      setMarkdown(md);
    },
  });

  // Switch to WYSIWYG: re-hydrate the editor document from the canonical Markdown
  // the user may have edited in the textarea, so the two views stay in lock-step.
  function toWysiwyg(): void {
    if (editor !== null) {
      editor.commands.setContent(markdown, false);
    }
    setMode('wysiwyg');
  }

  function toMarkdown(): void {
    if (editor !== null) {
      setMarkdown(editor.storage.markdown.getMarkdown());
    }
    setMode('markdown');
  }

  return (
    <div className="content-editor">
      <div className="content-editor__modes" role="tablist" aria-label="Editor mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'wysiwyg'}
          className={modeClass(mode === 'wysiwyg')}
          onClick={toWysiwyg}
        >
          Rich text
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'markdown'}
          className={modeClass(mode === 'markdown')}
          onClick={toMarkdown}
        >
          Markdown
        </button>
      </div>

      {mode === 'wysiwyg' ? (
        <div className="content-editor__wysiwyg">
          <EditorContent editor={editor} />
        </div>
      ) : (
        <textarea
          className="content-editor__markdown"
          aria-label="Article body (Markdown)"
          value={markdown}
          spellCheck
          rows={18}
          onChange={(e) => setMarkdown(e.target.value)}
        />
      )}

      {/* Canonical Markdown — the single value the form submits, both modes. */}
      <input type="hidden" name={name} value={markdown} readOnly />
    </div>
  );
}

function modeClass(active: boolean): string {
  return active ? 'content-editor__mode content-editor__mode--active' : 'content-editor__mode';
}
