import { type Chef, CHEFS, type ServiceColor } from './data';

const swatchClass: Record<ServiceColor, string> = {
  clay: 'weave-clay',
  sage: 'weave-sage',
  espresso: 'weave-espresso',
};

function ChefCard({ c }: { readonly c: Chef }): React.JSX.Element {
  return (
    <article className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className={swatchClass[c.color]}
        style={{ height: 220, position: 'relative', overflow: 'hidden' }}
      >
        <div
          className="photo"
          data-label="Portrait"
          style={{
            position: 'absolute',
            inset: 14,
            background: 'rgba(246,241,231,0.78)',
          }}
        />
      </div>
      <div
        style={{
          padding: '20px 22px',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="mono" style={{ color: 'var(--clay)' }}>
          {c.role}
        </div>
        <h3 className="serif mt-2" style={{ fontSize: 24, color: 'var(--espresso)' }}>
          {c.name}
        </h3>
        <div className="mono mt-2" style={{ color: 'var(--ink-soft)' }}>
          {c.where}
        </div>
        <p className="mt-4" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {c.note}
        </p>
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 16,
            borderTop: '1px solid var(--rule)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {c.creds.map((cr) => (
            <div key={cr} className="mono" style={{ color: 'var(--ink-soft)', fontSize: 10 }}>
              · {cr}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function MeetChefs(): React.JSX.Element {
  return (
    <section
      id="chefs"
      className="section"
      style={{ background: 'var(--paper)', borderTop: '1px solid var(--rule)' }}
    >
      <div className="wrap">
        <div
          className="flex justify-between"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 24 }}
        >
          <div>
            <div className="eyebrow">Meet the team</div>
            <h2 className="h2 mt-4" style={{ maxWidth: '14ch' }}>
              The hands at{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                your kitchen counter.
              </span>
            </h2>
          </div>
          <p className="lead" style={{ maxWidth: 420 }}>
            Every chef and companion is matched in person, in the home — no app-shuffle, no rotating
            strangers. A small, consistent team your loved one knows by name.
          </p>
        </div>

        <div className="mt-12 grid-chefs">
          {CHEFS.map((c) => (
            <ChefCard key={c.name} c={c} />
          ))}
        </div>

        <div
          className="mt-8 flex justify-between"
          style={{
            alignItems: 'center',
            paddingTop: 24,
            borderTop: '1px solid var(--rule)',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-soft)' }}>
            240+ chefs · 180+ companions · serving 8 metros
          </span>
          <a href="#" className="btn btn-ghost btn-arrow">
            Browse the full team
          </a>
        </div>
      </div>
    </section>
  );
}
