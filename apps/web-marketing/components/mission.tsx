export function Mission(): React.JSX.Element {
  return (
    <section id="about" className="section">
      <div className="wrap">
        <div className="row-split-mission">
          <div style={{ position: 'relative', minHeight: 480 }}>
            <div
              className="weave-sage"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 280,
                height: 360,
                borderRadius: 4,
              }}
            />
            <div
              className="photo"
              data-label="Founder · home kitchen"
              style={{
                position: 'absolute',
                right: 0,
                top: 60,
                width: 280,
                height: 360,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 30,
                bottom: 0,
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                padding: '14px 18px',
                borderRadius: 4,
                boxShadow: 'var(--shadow-card-lift)',
              }}
            >
              <div className="mono" style={{ color: 'var(--clay)' }}>
                Est. 2022 · Brooklyn
              </div>
            </div>
          </div>
          <div>
            <div className="eyebrow">A note from our founder</div>
            <h2 className="h2 mt-4">
              We started Taste & See because{' '}
              <span className="serif-i" style={{ color: 'var(--clay)' }}>
                my mother
              </span>{' '}
              stopped cooking.
            </h2>
            <p className="lead mt-6">
              Not all at once. Slowly. The crisper drawer thinning, the same three things on repeat,
              an honest answer when I asked: <em>I just don’t feel like it anymore.</em>
            </p>
            <p className="mt-4" style={{ maxWidth: '54ch' }}>
              Aging in place is mostly small things — a warm meal, a familiar voice at noon, someone
              who notices the bread is moldy. We built Taste & See to give those small things back,
              with the dignity of a real chef and the quiet of a real home. We are a benefit
              corporation, and we pay every chef and companion a living wage.
            </p>
            <div className="mt-8 flex gap-6" style={{ alignItems: 'center' }}>
              <div className="logo-glyph" style={{ width: 40, height: 40 }} aria-hidden="true" />
              <div>
                <div className="serif" style={{ fontSize: 18, color: 'var(--espresso)' }}>
                  Helena Park
                </div>
                <div className="mono" style={{ color: 'var(--ink-soft)' }}>
                  Founder & CEO
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
