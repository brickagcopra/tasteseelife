'use client';

import { useCallback, useRef, useState } from 'react';

import type { DisqusEmbedConfig } from '@/lib/comments';

/**
 * Click-to-load Disqus embed (TS-289-followup-1).
 *
 * Loading Disqus injects third-party scripts and cookies, so nothing is
 * fetched from Disqus until the reader explicitly asks (CLAUDE.md §12 —
 * third-party sharing is opt-in, never ambient). The initial render is the
 * consent card only; the embed script is appended on click and this component
 * never re-requests it (`loaded` latches).
 *
 * Kept deliberately tiny — it is the only client component on the article
 * route besides nothing (the page is otherwise fully server-rendered), so its
 * chunk is the measure of this feature's bundle cost.
 */

declare global {
  interface Window {
    // Disqus's documented globals (https://help.disqus.com/): the embed script
    // reads `disqus_config` at load time.
    disqus_config?: (this: DisqusConfigContext) => void;
  }
}

interface DisqusConfigContext {
  page: { identifier?: string; url?: string };
}

export function DisqusComments({
  config,
}: {
  readonly config: DisqusEmbedConfig;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const showComments = useCallback(() => {
    if (loaded) return;
    setLoaded(true);

    window.disqus_config = function configure(this: DisqusConfigContext) {
      this.page.identifier = config.identifier;
      if (config.pageUrl !== null) this.page.url = config.pageUrl;
    };

    const script = document.createElement('script');
    script.src = `https://${encodeURIComponent(config.shortname)}.disqus.com/embed.js`;
    script.setAttribute('data-timestamp', String(Date.now()));
    script.async = true;
    document.body.appendChild(script);
  }, [loaded, config]);

  return (
    <section className="blog-comments" aria-label="Reader comments">
      <h2 className="serif blog-comments-title">Join the conversation</h2>
      {loaded ? (
        <div id="disqus_thread" ref={threadRef} aria-label="Comments, hosted by Disqus" />
      ) : (
        <>
          <p className="blog-comments-note">
            Comments are hosted by our partner Disqus. Choosing to show them shares your visit with
            Disqus under their privacy policy — nothing loads until you ask.
          </p>
          <button type="button" className="btn btn-clay" onClick={showComments}>
            Show comments
          </button>
        </>
      )}
    </section>
  );
}
