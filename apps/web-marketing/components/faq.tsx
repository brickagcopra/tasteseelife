'use client';

import { useState } from 'react';

import { FAQ } from './data';

export function FaqSection(): React.JSX.Element {
  const [open, setOpen] = useState<number>(0);

  return (
    <section id="faq" className="section">
      <div className="wrap row-split-faq">
        <div>
          <div className="eyebrow">Quiet questions, careful answers</div>
          <h2 className="h2 mt-4">
            Things families{' '}
            <span className="serif-i" style={{ color: 'var(--clay)' }}>
              most often ask.
            </span>
          </h2>
          <p className="lead mt-6">
            Don’t see your question? Our care team answers every email within four business hours,
            weekdays and weekends.
          </p>
          <div className="mt-8 flex gap-3">
            <a href="mailto:hello@tasteandsee.example" className="btn btn-ghost">
              hello@tasteandsee.example
            </a>
          </div>
        </div>
        <div>
          {FAQ.map((f, i) => (
            <div key={f.q} className="faq-item">
              <button
                type="button"
                className="faq-q"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                <span>{f.q}</span>
                <span className="faq-toggle" aria-hidden="true">
                  {open === i ? '–' : '+'}
                </span>
              </button>
              <div
                className="faq-a"
                style={{
                  maxHeight: open === i ? 240 : 0,
                  opacity: open === i ? 1 : 0,
                  marginTop: open === i ? 14 : 0,
                }}
              >
                <p style={{ margin: 0, maxWidth: '60ch' }}>{f.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
