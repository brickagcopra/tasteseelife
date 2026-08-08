'use client';

import { useRef, useState } from 'react';

import { type Day, WEEK } from './data';

function DayCard({
  d,
  active,
  onClick,
}: {
  readonly d: Day;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <article
      onClick={onClick}
      className="card day-card"
      style={{
        width: 380,
        padding: 0,
        cursor: 'pointer',
        transition: 'transform 0.3s ease, border-color 0.2s ease',
        transform: active ? 'translateY(-4px)' : 'none',
        borderColor: active ? 'var(--espresso)' : 'var(--rule)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        className="weave"
        style={{
          padding: '22px 24px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
        }}
      >
        <div>
          <div className="mono" style={{ color: 'var(--ink-soft)' }}>
            {d.date}
          </div>
          <div
            className="serif"
            style={{ fontSize: 36, color: 'var(--espresso)', lineHeight: 1, marginTop: 4 }}
          >
            {d.day}
          </div>
        </div>
        <div className="chip" style={{ background: 'var(--paper)', fontSize: 11 }}>
          {d.visit}
        </div>
      </div>
      <div style={{ padding: '8px 24px 22px', flex: 1 }}>
        {d.meals.map((m) => (
          <div
            key={m.kind}
            style={{
              padding: '14px 0',
              borderTop: '1px solid var(--rule)',
            }}
          >
            <div className="mono" style={{ color: 'var(--clay)', fontSize: 10 }}>
              {m.kind}
            </div>
            <div
              className="serif"
              style={{
                fontSize: 17,
                color: 'var(--espresso)',
                marginTop: 6,
                lineHeight: 1.25,
              }}
            >
              {m.name}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: '12px 24px',
          borderTop: '1px solid var(--rule)',
          background: 'var(--paper)',
        }}
      >
        <span className="mono" style={{ color: 'var(--ink-soft)' }}>
          {d.note}
        </span>
      </div>
    </article>
  );
}

export function SampleWeek(): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const active = WEEK[idx];

  const scrollTo = (i: number): void => {
    setIdx(i);
    const el = ref.current;
    if (el === null) return;
    const card = el.children[i] as HTMLElement | undefined;
    if (card !== undefined) {
      el.scrollTo({ left: card.offsetLeft - 40, behavior: 'smooth' });
    }
  };

  return (
    <section id="menu" className="section" style={{ background: 'var(--paper)' }}>
      <div className="wrap">
        <div
          className="flex justify-between"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 24 }}
        >
          <div>
            <div className="eyebrow">A week at the table</div>
            <h2 className="h2 mt-4" style={{ maxWidth: '16ch' }}>
              Real menus.{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                Real homes.
              </span>
            </h2>
            <p className="lead mt-6">
              A week from a Taste & See household in late April — chef visits, companion lunches,
              and quiet pantry days. Every plan is built around your loved one’s tastes.
            </p>
          </div>
          <div className="flex gap-3" style={{ alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => scrollTo(Math.max(0, idx - 1))}
              className="btn btn-ghost"
              style={{ padding: '10px 14px' }}
              aria-label="Previous day"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => scrollTo(Math.min(WEEK.length - 1, idx + 1))}
              className="btn btn-ghost"
              style={{ padding: '10px 14px' }}
              aria-label="Next day"
            >
              →
            </button>
          </div>
        </div>

        <div className="mt-12 carousel" ref={ref}>
          {WEEK.map((d, i) => (
            <DayCard key={d.day} d={d} active={i === idx} onClick={() => scrollTo(i)} />
          ))}
        </div>

        <div className="mt-8 flex gap-3" style={{ alignItems: 'center' }}>
          {WEEK.map((d, i) => (
            <button
              key={d.day}
              type="button"
              onClick={() => scrollTo(i)}
              aria-label={`Go to ${d.day}`}
              style={{
                width: i === idx ? 28 : 8,
                height: 8,
                borderRadius: 999,
                background: i === idx ? 'var(--espresso)' : 'var(--rule)',
                border: 0,
                padding: 0,
                transition: 'all 0.25s ease',
              }}
            />
          ))}
          {active !== undefined && (
            <span className="mono" style={{ marginLeft: 16, color: 'var(--ink-soft)' }}>
              {active.day} · {active.date}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
