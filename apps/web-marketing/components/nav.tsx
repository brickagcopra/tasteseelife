'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

function LogoMark(): React.JSX.Element {
  return (
    <a className="logo-mark" href="#top" aria-label="Taste & See home">
      <span className="logo-glyph" aria-hidden="true" />
      <span>Taste & See</span>
    </a>
  );
}

export function Nav(): React.JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = (): void => {
      const y = window.scrollY;
      setScrolled(y > 8);
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(h > 0 ? Math.min(100, (y / h) * 100) : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <LogoMark />
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#services">Services</a>
          <a href="#menu">A week at the table</a>
          <a href="#chefs">Our team</a>
          <a href="#family">Family app</a>
          <a href="#pricing">Plans</a>
          <Link href="/blog">Journal</Link>
        </div>
        <div className="flex items-center gap-3">
          <a href="#quiz" className="btn btn-ghost" style={{ padding: '10px 16px', fontSize: 13 }}>
            Sign in
          </a>
          <a
            href="#quiz"
            className="btn btn-primary"
            style={{ padding: '10px 18px', fontSize: 13 }}
          >
            Build your plan
          </a>
        </div>
      </div>
      <div className="scroll-progress" style={{ width: `${progress}%` }} />
    </nav>
  );
}
