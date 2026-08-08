import Link from 'next/link';

import { Footer } from '../footer';

/**
 * Server-rendered chrome for the journal pages (TS-282-followup-3). The home
 * page's `Nav` is a client component whose links are same-page section
 * anchors; the journal instead gets this quiet static header — logo home,
 * journal index, and the one primary CTA — so blog pages ship zero client JS
 * of their own.
 */
export function BlogShell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <header className="blog-header">
        <div className="blog-header-inner">
          <Link className="logo-mark" href="/" aria-label="Taste & See home">
            <span className="logo-glyph" aria-hidden="true" />
            <span>Taste &amp; See</span>
          </Link>
          <nav aria-label="Journal">
            <Link className="blog-header-link" href="/blog">
              Journal
            </Link>
            <Link
              className="btn btn-ghost"
              style={{ padding: '10px 16px', fontSize: 13 }}
              href="/#quiz"
            >
              Build your plan
            </Link>
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <Footer />
    </>
  );
}
