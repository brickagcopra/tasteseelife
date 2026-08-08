import Link from 'next/link';

import { BlogShell } from '@/components/blog/blog-shell';

export default function BlogArticleNotFound(): React.JSX.Element {
  return (
    <BlogShell>
      <section className="section">
        <div className="wrap blog-article">
          <span className="eyebrow">Journal</span>
          <h1 className="serif blog-title">We couldn&rsquo;t find that story</h1>
          <p className="blog-lede">
            It may have been moved, or the link may have been mistyped. The rest of the journal is
            still warm.
          </p>
          <p>
            <Link className="btn btn-ghost" href="/blog">
              Back to the journal
            </Link>
          </p>
        </div>
      </section>
    </BlogShell>
  );
}
