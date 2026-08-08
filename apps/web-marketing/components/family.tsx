'use client';

import { useState } from 'react';

import { FAMILY_FEATURES } from './data';

type DashboardTab = 'feed' | 'menu' | 'team';

const TABS: ReadonlyArray<{ id: DashboardTab; label: string }> = [
  { id: 'feed', label: 'Visit feed' },
  { id: 'menu', label: 'This week' },
  { id: 'team', label: 'Team' },
];

function FeedTab(): React.JSX.Element {
  const items = [
    {
      who: 'Imani · Lead Chef',
      when: 'Today, 1:14 pm',
      tag: 'Visit',
      body: '“Made the apricot oats again — she lit up. Lunch was the lemon-herb chicken; she ate everything. Talked about the trip to Lisbon for an hour.”',
      photo: true,
      color: 'clay',
    },
    {
      who: 'Marco · Companion',
      when: 'Yesterday, 12:40 pm',
      tag: 'Companion lunch',
      body: '“We made the bisque together. She wanted music — we put on Ella. She walked me to the door, which is new and wonderful.”',
      photo: false,
      color: 'sage',
    },
    {
      who: 'Care Lead · Naomi',
      when: 'Mon, 9:02 am',
      tag: 'Wellness flag',
      body: '“Slight dip in mobility scores over the weekend. Gentle plan: shorter walks, more soft seating. Will revisit Friday.”',
      photo: false,
      color: 'espresso',
    },
  ] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {items.map((it) => (
        <div
          key={it.who}
          style={{
            display: 'grid',
            gridTemplateColumns: it.photo ? '110px 1fr' : '1fr',
            gap: 16,
            padding: 16,
            border: '1px solid var(--rule)',
            borderRadius: 6,
          }}
        >
          {it.photo && (
            <div
              className={`weave-${it.color}`}
              style={{ borderRadius: 4, position: 'relative', minHeight: 110 }}
            >
              <div
                className="photo"
                data-label="Plate"
                style={{ position: 'absolute', inset: 6, background: 'rgba(246,241,231,0.7)' }}
              />
            </div>
          )}
          <div>
            <div className="flex justify-between" style={{ alignItems: 'center' }}>
              <div className="mono" style={{ color: 'var(--clay)' }}>
                {it.tag}
              </div>
              <div className="mono" style={{ color: 'var(--ink-soft)' }}>
                {it.when}
              </div>
            </div>
            <div
              className="serif"
              style={{
                fontSize: 16,
                color: 'var(--espresso)',
                marginTop: 8,
                lineHeight: 1.45,
              }}
            >
              {it.body}
            </div>
            <div className="mono mt-2" style={{ color: 'var(--ink-soft)' }}>
              {it.who}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ThisWeekTab(): React.JSX.Element {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const visits = ['Chef', 'Companion', 'Caregiver', 'Chef', 'Companion', 'Concierge', '—'];
  return (
    <div>
      <div className="grid-week">
        {days.map((d, i) => (
          <div
            key={d}
            style={{
              border: '1px solid var(--rule)',
              borderRadius: 4,
              padding: 12,
              background: i === 1 ? 'var(--linen)' : 'var(--paper)',
            }}
          >
            <div className="mono" style={{ color: 'var(--ink-soft)' }}>
              {d}
            </div>
            <div className="serif" style={{ fontSize: 22, color: 'var(--espresso)', marginTop: 4 }}>
              {21 + i}
            </div>
            <div
              className="mono mt-4"
              style={{
                color: visits[i] === '—' ? 'var(--ink-soft)' : 'var(--clay)',
                fontSize: 9,
              }}
            >
              {visits[i]}
            </div>
          </div>
        ))}
      </div>
      <div
        className="mt-6"
        style={{
          padding: 16,
          background: 'var(--linen)',
          borderRadius: 6,
          border: '1px solid var(--rule)',
        }}
      >
        <div className="mono" style={{ color: 'var(--clay)' }}>
          Tue · today
        </div>
        <div className="serif mt-2" style={{ fontSize: 17, color: 'var(--espresso)' }}>
          Companion lunch · Marco · 11:00 — 1:00
        </div>
        <div className="mono mt-2" style={{ color: 'var(--ink-soft)' }}>
          Tomato bisque · grilled cheese soldiers · stewed plums
        </div>
      </div>
    </div>
  );
}

function TeamTab(): React.JSX.Element {
  const team = [
    { who: 'Imani Okafor', role: 'Lead Chef', tag: 'Mon · Thu', color: 'clay' },
    { who: 'Marco Devereux', role: 'Companion', tag: 'Tue · Fri', color: 'sage' },
    { who: 'Naomi Hart', role: 'Care Lead', tag: 'Always-on', color: 'espresso' },
    { who: 'David Liu', role: 'Concierge', tag: 'Sat', color: 'clay' },
  ] as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {team.map((p) => (
        <div
          key={p.who}
          style={{
            display: 'grid',
            gridTemplateColumns: '48px 1fr auto',
            gap: 14,
            alignItems: 'center',
            padding: '12px 14px',
            border: '1px solid var(--rule)',
            borderRadius: 6,
          }}
        >
          <div
            className={`weave-${p.color}`}
            style={{ width: 48, height: 48, borderRadius: 999 }}
          />
          <div>
            <div className="serif" style={{ fontSize: 17, color: 'var(--espresso)' }}>
              {p.who}
            </div>
            <div className="mono" style={{ color: 'var(--ink-soft)' }}>
              {p.role}
            </div>
          </div>
          <div className="chip">{p.tag}</div>
        </div>
      ))}
    </div>
  );
}

function DashboardMock({
  tab,
  setTab,
}: {
  readonly tab: DashboardTab;
  readonly setTab: (t: DashboardTab) => void;
}): React.JSX.Element {
  return (
    <div className="dashboard" style={{ color: 'var(--ink)' }}>
      <div className="dashboard-bar">
        <div className="dot" />
        <div className="dot" />
        <div className="dot" />
        <div className="mono" style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>
          tasteandsee.app · the Park family
        </div>
        <div className="mono" style={{ marginLeft: 'auto', color: 'var(--ink-soft)' }}>
          Tue · 4:12 pm
        </div>
      </div>

      <div style={{ padding: '24px 28px', borderBottom: '1px solid var(--rule)' }}>
        <div className="flex justify-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="mono" style={{ color: 'var(--clay)' }}>
              Caring for
            </div>
            <div className="serif" style={{ fontSize: 28, color: 'var(--espresso)', marginTop: 4 }}>
              Eleanor Park, 78
            </div>
            <div className="mono mt-2" style={{ color: 'var(--ink-soft)' }}>
              Brooklyn, NY · Plan: Table
            </div>
          </div>
          <div className="weave-sage" style={{ width: 48, height: 48, borderRadius: 999 }} />
        </div>

        <div className="mt-6 dashboard-metrics">
          {[
            { l: 'Appetite', v: 'Steady', c: 'var(--sage)' },
            { l: 'Mood', v: 'Bright', c: 'var(--clay)' },
            { l: 'Sleep', v: '7.4 hrs', c: 'var(--sage)' },
            { l: 'Mobility', v: 'Watch', c: 'var(--clay-deep)' },
          ].map((s) => (
            <div key={s.l} style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
              <div className="mono" style={{ color: 'var(--ink-soft)' }}>
                {s.l}
              </div>
              <div
                style={{
                  fontFamily: 'var(--serif)',
                  fontSize: 22,
                  color: s.c,
                  marginTop: 2,
                }}
              >
                {s.v}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--rule)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              background: 'transparent',
              border: 0,
              padding: '14px 22px',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: tab === t.id ? 'var(--espresso)' : 'var(--ink-soft)',
              borderBottom: tab === t.id ? '2px solid var(--clay)' : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 24, minHeight: 320, background: 'var(--paper)' }}>
        {tab === 'feed' && <FeedTab />}
        {tab === 'menu' && <ThisWeekTab />}
        {tab === 'team' && <TeamTab />}
      </div>
    </div>
  );
}

export function Family(): React.JSX.Element {
  const [tab, setTab] = useState<DashboardTab>('feed');

  return (
    <section id="family" className="section weave-espresso" style={{ color: 'var(--linen)' }}>
      <div className="wrap">
        <div className="row-split-family">
          <div>
            <div className="eyebrow" style={{ color: 'var(--linen-2)' }}>
              Peace of mind, quietly delivered
            </div>
            <h2 className="h2 mt-4" style={{ color: 'var(--paper)' }}>
              The whole family,{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                on the same page.
              </span>
            </h2>
            <p className="lead mt-6" style={{ color: 'var(--linen)', opacity: 0.85 }}>
              No installations, no learning curve for your loved one. The care happens in their
              kitchen — the updates come quietly to your phone.
            </p>

            <div
              className="mt-8"
              style={{ display: 'grid', gap: 1, background: 'rgba(232,220,196,0.18)' }}
            >
              {FAMILY_FEATURES.map((f) => (
                <div key={f.title} className="row-feature">
                  <div className="serif" style={{ fontSize: 20, color: 'var(--paper)' }}>
                    {f.title}
                  </div>
                  <div
                    style={{
                      color: 'var(--linen)',
                      opacity: 0.8,
                      fontSize: 14,
                      lineHeight: 1.55,
                    }}
                  >
                    {f.body}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8 flex gap-3">
              <a href="#quiz" className="btn btn-clay btn-arrow">
                Build your plan
              </a>
              <a
                href="#pricing"
                className="btn btn-ghost"
                style={{ color: 'var(--paper)', borderColor: 'var(--paper)' }}
              >
                See plans
              </a>
            </div>
          </div>

          <DashboardMock tab={tab} setTab={setTab} />
        </div>
      </div>
    </section>
  );
}
