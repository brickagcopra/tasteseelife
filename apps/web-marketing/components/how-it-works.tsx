import { STEPS } from './data';

export function HowItWorks(): React.JSX.Element {
  return (
    <section id="how" className="section">
      <div className="wrap">
        <div className="row-split-2">
          <div className="sticky-pane">
            <div className="eyebrow">A small ritual</div>
            <h2 className="h2" style={{ marginTop: 24 }}>
              Four quiet steps from{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                hello
              </span>{' '}
              to a home that hums.
            </h2>
            <p className="lead mt-6">
              Taste & See is built around continuity. The same small team, the same kitchen, the
              same pace — month after month. No app downloads, no learning curve, no rotating
              strangers in the doorway.
            </p>
            <div className="weave mt-8" style={{ height: 6, width: 120, borderRadius: 1 }} />
          </div>

          <div>
            {STEPS.map((s, i) => (
              <div
                key={s.n}
                className="row-step"
                style={
                  i === STEPS.length - 1 ? { borderBottom: '1px solid var(--rule)' } : undefined
                }
              >
                <div>
                  <div className="num">{s.n}</div>
                  <div className="mono mt-4" style={{ color: 'var(--clay)' }}>
                    Step {s.n}
                  </div>
                </div>
                <div>
                  <h3 className="h3">{s.title}</h3>
                  <p className="mt-4" style={{ maxWidth: '52ch' }}>
                    {s.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
