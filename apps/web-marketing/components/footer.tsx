interface FooterLink {
  readonly label: string;
  readonly href: string;
}

interface FooterColumn {
  readonly h: string;
  readonly links: readonly FooterLink[];
}

const COLUMNS: readonly FooterColumn[] = [
  {
    h: 'Services',
    links: [
      { label: 'In-home chef', href: '#' },
      { label: 'Companion', href: '#' },
      { label: 'Caregiver', href: '#' },
      { label: 'Concierge', href: '#' },
    ],
  },
  {
    h: 'Taste & See',
    links: [
      { label: 'About', href: '#' },
      { label: 'Our team', href: '#' },
      { label: 'Journal', href: '/blog' },
      { label: 'Press', href: '#' },
      { label: 'Careers', href: '#' },
    ],
  },
  {
    h: 'For families',
    links: [
      { label: 'Family app', href: '#' },
      { label: 'Insurance', href: '#' },
      { label: 'Gift a plan', href: '#' },
      { label: 'Care guides', href: '/blog' },
    ],
  },
];

export function Footer(): React.JSX.Element {
  return (
    <footer className="footer selvedge-top">
      <div className="wrap">
        <div className="grid-footer">
          <div>
            <div className="logo-mark" style={{ color: 'var(--paper)' }}>
              <span className="logo-glyph" aria-hidden="true" />
              <span style={{ color: 'var(--paper)' }}>Taste & See</span>
            </div>
            <p
              style={{
                color: 'var(--linen)',
                opacity: 0.78,
                marginTop: 18,
                maxWidth: '36ch',
              }}
            >
              A subscription-based culinary wellness and companionship platform — set with care,
              served at home.
            </p>
            <div className="mono mt-6">B Corp · LTC-insurance-friendly</div>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.h}>
              <div className="mono" style={{ marginBottom: 14 }}>
                {col.h}
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'grid',
                  gap: 10,
                }}
              >
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} style={{ fontSize: 14 }}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <div className="mono" style={{ marginBottom: 14 }}>
              Stay in touch
            </div>
            <p
              style={{
                color: 'var(--linen)',
                opacity: 0.78,
                fontSize: 13,
                margin: '0 0 12px',
              }}
            >
              A monthly letter — care guides, recipes, and gentle ideas for aging well at home.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="email"
                placeholder="your@email.com"
                aria-label="Email address"
                style={{
                  flex: 1,
                  background: 'transparent',
                  borderColor: 'rgba(232,220,196,0.4)',
                  color: 'var(--paper)',
                }}
              />
              <button type="button" className="btn btn-clay" style={{ padding: '10px 16px' }}>
                Sign up
              </button>
            </div>
          </div>
        </div>

        <div
          className="mt-16"
          style={{
            paddingTop: 24,
            borderTop: '1px solid rgba(232,220,196,0.18)',
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <span className="mono">© 2026 Taste &amp; See, PBC · Brooklyn, NY</span>
          <span className="mono">Privacy · Terms · Accessibility</span>
        </div>
      </div>
    </footer>
  );
}
