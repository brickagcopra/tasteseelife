'use client';

import { useState } from 'react';

import { type Plan, PLANS } from './data';

type Cycle = 'monthly' | 'quarterly';

function PlanCard({ p, cycle }: { readonly p: Plan; readonly cycle: Cycle }): React.JSX.Element {
  const price = cycle === 'monthly' ? p.monthly : p.quarterly;
  const featured = p.featured;
  return (
    <article
      className={`card ${featured ? 'selvedge-top plan-featured' : ''}`}
      style={{
        padding: 0,
        background: featured ? 'var(--espresso)' : 'var(--paper)',
        color: featured ? 'var(--linen)' : 'var(--ink)',
        transform: featured ? 'translateY(-12px)' : 'none',
        borderColor: featured ? 'var(--espresso)' : 'var(--rule)',
        // Match the design's exact featured-card lift (alpha 0.4); the
        // base `--shadow-card` token sits at alpha 0.25 and reads too soft
        // against the espresso background.
        boxShadow: featured ? '0 30px 60px -30px rgba(61, 46, 31, 0.4)' : 'none',
      }}
    >
      <div style={{ padding: '28px 28px 0' }}>
        <div className="flex justify-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="mono" style={{ color: 'var(--clay)' }}>
              {featured ? 'Most chosen' : 'Plan'}
            </div>
            <h3
              className="serif mt-2"
              style={{
                fontSize: 36,
                color: featured ? 'var(--paper)' : 'var(--espresso)',
                fontWeight: 300,
                lineHeight: 1,
              }}
            >
              {p.name}
            </h3>
            <div
              className="mt-2"
              style={{
                fontFamily: 'var(--serif)',
                fontStyle: 'italic',
                color: featured ? 'var(--linen-2)' : 'var(--ink-soft)',
                fontSize: 16,
              }}
            >
              {p.sub}
            </div>
          </div>
        </div>

        <div className="mt-6" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            className="serif"
            style={{
              fontSize: 56,
              fontWeight: 300,
              lineHeight: 1,
              color: featured ? 'var(--paper)' : 'var(--espresso)',
              letterSpacing: '-0.02em',
            }}
          >
            ${price.toLocaleString()}
          </span>
          <span className="mono" style={{ color: featured ? 'var(--linen-2)' : 'var(--ink-soft)' }}>
            / mo
          </span>
        </div>
        {cycle === 'quarterly' && (
          <div className="mono mt-2" style={{ color: 'var(--clay)' }}>
            billed quarterly · ${(price * 3).toLocaleString()}
          </div>
        )}
      </div>

      <ul style={{ listStyle: 'none', padding: '24px 28px', margin: 0 }}>
        {p.includes.map((line) => (
          <li
            key={line}
            style={{
              padding: '12px 0',
              borderTop: `1px solid ${featured ? 'rgba(232,220,196,0.18)' : 'var(--rule)'}`,
              display: 'flex',
              gap: 12,
              fontSize: 14,
              color: featured ? 'var(--linen)' : 'var(--ink)',
            }}
          >
            <span style={{ color: 'var(--clay)' }}>·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <div style={{ padding: '0 28px 28px' }}>
        <a
          href="#quiz"
          className={featured ? 'btn btn-clay btn-arrow' : 'btn btn-primary btn-arrow'}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {p.cta}
        </a>
      </div>
    </article>
  );
}

export function Pricing(): React.JSX.Element {
  const [cycle, setCycle] = useState<Cycle>('monthly');
  return (
    <section id="pricing" className="section">
      <div className="wrap">
        <div
          className="flex justify-between"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 24 }}
        >
          <div>
            <div className="eyebrow">Plans for every household</div>
            <h2 className="h2 mt-4" style={{ maxWidth: '15ch' }}>
              A subscription, like the{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                weekly market.
              </span>
            </h2>
            <p className="lead mt-6">
              Cancel, pause for travel, or scale up as needs change. Every plan includes the family
              app, the dietitian-led menu, and a dedicated care lead.
            </p>
          </div>

          <div
            style={{
              display: 'inline-flex',
              padding: 4,
              border: '1px solid var(--rule)',
              borderRadius: 999,
              background: 'var(--paper)',
            }}
          >
            {(['monthly', 'quarterly'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCycle(c)}
                style={{
                  padding: '10px 20px',
                  border: 0,
                  borderRadius: 999,
                  background: cycle === c ? 'var(--espresso)' : 'transparent',
                  color: cycle === c ? 'var(--paper)' : 'var(--ink-soft)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                {c}
                {c === 'quarterly' && (
                  <span style={{ color: 'var(--clay)', marginLeft: 6 }}>· save 8%</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-12 grid-plans">
          {PLANS.map((p) => (
            <PlanCard key={p.name} p={p} cycle={cycle} />
          ))}
        </div>

        <div
          className="mt-8 flex justify-between"
          style={{
            alignItems: 'center',
            padding: '20px 24px',
            background: 'var(--linen)',
            borderRadius: 6,
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <div className="serif" style={{ fontSize: 20, color: 'var(--espresso)' }}>
              Many long-term care policies cover Taste & See.
            </div>
            <div className="mono mt-2" style={{ color: 'var(--ink-soft)' }}>
              We provide itemized statements and speak directly with insurers and care managers.
            </div>
          </div>
          <a href="#" className="btn btn-ghost btn-arrow">
            Insurance & coverage
          </a>
        </div>
      </div>
    </section>
  );
}
