'use client';

import { useState } from 'react';

import { type Service, type ServiceColor, SERVICES } from './data';

const TAGS = [
  { id: 'all', label: 'All services' },
  { id: 'chef', label: 'Culinary' },
  { id: 'companion', label: 'Connection' },
  { id: 'caregiver', label: 'Wellness' },
  { id: 'concierge', label: 'Logistics' },
] as const;

type FilterId = (typeof TAGS)[number]['id'];

const swatchClass: Record<ServiceColor, string> = {
  clay: 'weave-clay',
  sage: 'weave-sage',
  espresso: 'weave-espresso',
};

function ServiceCard({
  s,
  expanded,
}: {
  readonly s: Service;
  readonly expanded: boolean;
}): React.JSX.Element {
  return (
    <article
      className={`card service-card-grid${expanded ? ' service-card-grid--expanded' : ''}`}
      style={{
        padding: 0,
        background: 'var(--paper)',
      }}
    >
      <div
        className={swatchClass[s.color]}
        style={{ minHeight: expanded ? 'auto' : 140, position: 'relative' }}
      >
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 18,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--paper)',
            opacity: 0.85,
          }}
        >
          {s.tag}
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 18,
            right: 18,
            fontFamily: 'var(--serif)',
            fontSize: 80,
            fontWeight: 300,
            color: 'rgba(246,241,231,0.9)',
            lineHeight: 0.8,
          }}
        >
          {s.index}
        </div>
      </div>
      <div style={{ padding: '28px 30px' }}>
        <h3 className="h3">{s.name}</h3>
        <p className="mt-4">{s.summary}</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '20px 0 0' }}>
          {s.bullets.map((b) => (
            <li
              key={b}
              style={{
                display: 'flex',
                gap: 12,
                padding: '8px 0',
                borderTop: '1px solid var(--rule)',
                fontSize: 14,
                color: 'var(--ink)',
              }}
            >
              <span className="mono" style={{ color: 'var(--clay)', flexShrink: 0 }}>
                ·
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <div
          className="flex justify-between mt-6"
          style={{
            alignItems: 'center',
            borderTop: '1px solid var(--rule)',
            paddingTop: 16,
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-soft)' }}>
            {s.visit}
          </span>
          <a
            href="#quiz"
            className="mono"
            style={{
              color: 'var(--espresso)',
              textDecoration: 'underline',
              textUnderlineOffset: 4,
            }}
          >
            Add to plan →
          </a>
        </div>
      </div>
    </article>
  );
}

export function Services(): React.JSX.Element {
  const [active, setActive] = useState<FilterId>('all');
  const filtered = active === 'all' ? SERVICES : SERVICES.filter((s) => s.id === active);
  const expanded = filtered.length === 1;

  return (
    <section id="services" className="section weave" style={{ background: 'var(--linen)' }}>
      <div className="wrap">
        <div
          className="flex justify-between"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 24 }}
        >
          <div>
            <div className="eyebrow">What we bring to the table</div>
            <h2 className="h2 mt-4" style={{ maxWidth: '14ch' }}>
              Four kinds of care, woven together.
            </h2>
          </div>
          <p className="lead" style={{ maxWidth: 420 }}>
            Mix and match by the week. Most families begin with a chef and one companion, and grow
            into wellness or concierge support over time.
          </p>
        </div>

        <div className="flex gap-3 mt-8" style={{ flexWrap: 'wrap' }}>
          {TAGS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`chip ${active === t.id ? 'active' : ''}`}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={`mt-12 grid-services${expanded ? ' grid-services--expanded' : ''}`}>
          {filtered.map((s) => (
            <ServiceCard key={s.id} s={s} expanded={expanded} />
          ))}
        </div>
      </div>
    </section>
  );
}
