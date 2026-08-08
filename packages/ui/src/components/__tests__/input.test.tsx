import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Input } from '../input';

describe('Input', () => {
  it('renders a text input by default', () => {
    const html = renderToStaticMarkup(<Input placeholder="Email" />);
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="Email"');
  });

  it('honors type override', () => {
    const html = renderToStaticMarkup(<Input type="email" />);
    expect(html).toContain('type="email"');
  });

  it('binds tap-target hook so senior-mode promotes the height', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain('min-h-tap-min');
  });

  it('uses the rule border + clay focus ring in the default state', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain('border-rule');
    expect(html).toContain('focus-visible:ring-clay');
  });

  it('flips to clay-deep border + aria-invalid when invalid', () => {
    const html = renderToStaticMarkup(<Input invalid />);
    expect(html).toContain('border-clay-deep');
    expect(html).toContain('aria-invalid="true"');
  });

  it('omits aria-invalid when not invalid (no false negative for AT)', () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).not.toContain('aria-invalid');
  });

  it('caller className wins via tailwind-merge', () => {
    const html = renderToStaticMarkup(<Input className="bg-sage" />);
    expect(html).toContain('bg-sage');
    expect(html).not.toContain('bg-paper');
  });
});
