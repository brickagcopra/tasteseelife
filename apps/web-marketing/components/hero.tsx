function StaggerWords({
  text,
  baseDelay = 0,
}: {
  readonly text: string;
  readonly baseDelay?: number;
}): React.JSX.Element {
  const words = text.split(' ');
  return (
    <span>
      {words.map((w, i) => (
        // eslint-disable-next-line react/no-array-index-key -- words are stable per render
        <span
          key={i}
          style={{ display: 'inline-block', paddingBottom: '0.05em', marginRight: '0.32em' }}
        >
          <span
            className="hero-word"
            style={{ animationDelay: `${baseDelay + i * 0.07}s`, display: 'inline-block' }}
          >
            {w}
          </span>
        </span>
      ))}
    </span>
  );
}

function HeroStat({ n, l }: { readonly n: string; readonly l: string }): React.JSX.Element {
  return (
    <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, flex: 1, maxWidth: 200 }}>
      <div className="serif" style={{ fontSize: 32, color: 'var(--espresso)', lineHeight: 1 }}>
        {n}
      </div>
      <div className="mono" style={{ marginTop: 10, color: 'var(--ink-soft)' }}>
        {l}
      </div>
    </div>
  );
}

function HeroFigure(): React.JSX.Element {
  return (
    <div className="hero-figure">
      <div
        className="weave-clay"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '78%',
          height: 380,
          borderRadius: 4,
          opacity: 0,
          animation: 'rise 1s 0.3s forwards',
        }}
      />
      <div
        className="photo"
        data-label="Plated lunch · spring"
        style={{
          position: 'absolute',
          right: 32,
          top: 32,
          width: '74%',
          height: 380,
          opacity: 0,
          animation: 'rise 1s 0.5s forwards',
        }}
      />
      <div
        className="twill"
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: 220,
          height: 180,
          borderRadius: 4,
          opacity: 0,
          animation: 'rise 1s 0.7s forwards',
        }}
      />
      <div
        className="photo"
        data-label="Chef · prep"
        style={{
          position: 'absolute',
          left: 40,
          bottom: 28,
          width: 240,
          height: 220,
          opacity: 0,
          animation: 'rise 1s 0.9s forwards',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 240,
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          padding: '18px 20px',
          maxWidth: 260,
          borderRadius: 4,
          boxShadow: 'var(--shadow-card-lift)',
          opacity: 0,
          animation: 'rise 1s 1.1s forwards',
        }}
      >
        <div className="mono" style={{ color: 'var(--clay)' }}>
          Visit note · Tue
        </div>
        <div
          className="serif"
          style={{ fontSize: 18, marginTop: 8, color: 'var(--espresso)', lineHeight: 1.25 }}
        >
          “She asked for the apricot oats again. Ate everything. Told me about the trip to Lisbon.”
        </div>
        <div className="mono mt-4" style={{ color: 'var(--ink-soft)' }}>
          — Imani, lead chef
        </div>
      </div>
    </div>
  );
}

export function Hero(): React.JSX.Element {
  return (
    <section id="top" className="section" style={{ paddingTop: 80, paddingBottom: 80 }}>
      <div className="wrap">
        <div className="row-hero">
          <div>
            <div className="eyebrow rise" style={{ animationDelay: '0s' }}>
              <span style={{ opacity: 0, animation: 'rise 0.6s 0.1s forwards' }}>
                Culinary wellness · companionship · in-home care
              </span>
            </div>
            <h1 className="display" style={{ marginTop: 28 }}>
              <StaggerWords text="A table" baseDelay={0.15} />
              <br />
              <span className="serif-i" style={{ color: 'var(--clay)', fontWeight: 300 }}>
                <StaggerWords text="set with care," baseDelay={0.4} />
              </span>
              <br />
              <StaggerWords text="quietly, every week." baseDelay={0.75} />
            </h1>
            <p
              className="lead"
              style={{ marginTop: 32, opacity: 0, animation: 'rise 0.7s 1.4s forwards' }}
            >
              Taste & See pairs aging adults with professionally trained chefs, culinary companions,
              caregivers, and lifestyle concierges — delivering meaningful meals, gentle wellness,
              and aging-in-place support, right at home.
            </p>
            <div
              className="flex gap-3 mt-8"
              style={{ opacity: 0, animation: 'rise 0.7s 1.7s forwards' }}
            >
              <a href="#quiz" className="btn btn-primary btn-arrow">
                Build your plan
              </a>
              <a href="#how" className="btn btn-ghost">
                How it works
              </a>
            </div>
            <div
              className="mt-12 flex gap-8"
              style={{ opacity: 0, animation: 'rise 0.7s 2s forwards' }}
            >
              <HeroStat n="1 in 20" l="Applicants accepted to the Taste & See team" />
              <HeroStat n="14 yrs" l="Average culinary experience per chef" />
              <HeroStat n="48 hrs" l="From discovery call to first home visit" />
            </div>
          </div>
          <HeroFigure />
        </div>
      </div>
    </section>
  );
}
