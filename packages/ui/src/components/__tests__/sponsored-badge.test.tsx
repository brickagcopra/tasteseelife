import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SPONSORED_LABEL, SponsoredBadge } from '../sponsored-badge';

describe('SponsoredBadge', () => {
  it('exposes the canonical disclosure label constant', () => {
    expect(SPONSORED_LABEL).toBe('Sponsored');
  });

  it('renders the mandated label text (PDD §18.3) as real DOM text', () => {
    const html = renderToStaticMarkup(<SponsoredBadge />);
    expect(html).toContain('>Sponsored<');
  });

  it('renders the design-token pill class hooks (no hard-coded colours)', () => {
    const html = renderToStaticMarkup(<SponsoredBadge />);
    expect(html).toContain('border-ink-soft');
    expect(html).toContain('text-ink-soft');
    expect(html).toContain('rounded-full');
    expect(html).toContain('uppercase');
  });

  it('merges caller className via tailwind-merge (last wins on conflicts)', () => {
    const html = renderToStaticMarkup(<SponsoredBadge className="text-clay" />);
    expect(html).toContain('text-clay');
    // The conflicting token colour must be gone (tailwind-merge resolves the
    // last text-* utility).
    expect(html).not.toMatch(/(?:^|[\s"])text-ink-soft(?=[\s"])/);
  });

  it('passes through span attributes (aria-label / data-* / title)', () => {
    const html = renderToStaticMarkup(
      <SponsoredBadge aria-label="Sponsored placement" data-testid="disclosure" title="Paid" />,
    );
    expect(html).toContain('aria-label="Sponsored placement"');
    expect(html).toContain('data-testid="disclosure"');
    expect(html).toContain('title="Paid"');
  });
});
