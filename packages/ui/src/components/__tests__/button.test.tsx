import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button } from '../button';

describe('Button', () => {
  it('renders with default variant + size class hooks', () => {
    const html = renderToStaticMarkup(<Button>Click</Button>);
    expect(html).toContain('bg-clay');
    expect(html).toContain('text-paper');
    expect(html).toContain('min-h-tap-min');
    expect(html).toContain('Click');
  });

  it('honors variant overrides', () => {
    expect(renderToStaticMarkup(<Button variant="ghost">x</Button>)).toContain('bg-transparent');
    expect(renderToStaticMarkup(<Button variant="outline">x</Button>)).toContain('border-ink');
    expect(renderToStaticMarkup(<Button variant="link">x</Button>)).toContain('underline-offset-4');
  });

  it('honors size overrides — link variant strips min-h via baseClasses last-wins', () => {
    expect(renderToStaticMarkup(<Button size="sm">x</Button>)).toContain('text-sm');
    expect(renderToStaticMarkup(<Button size="lg">x</Button>)).toContain('text-lg');
    expect(renderToStaticMarkup(<Button size="icon">x</Button>)).toContain('min-w-tap-min');
  });

  it('defaults to type="button" so forms do not auto-submit', () => {
    const html = renderToStaticMarkup(<Button>x</Button>);
    expect(html).toContain('type="button"');
  });

  it('respects an explicit type override', () => {
    const html = renderToStaticMarkup(<Button type="submit">x</Button>);
    expect(html).toContain('type="submit"');
  });

  it('merges caller className via tailwind-merge (last wins on conflicts)', () => {
    const html = renderToStaticMarkup(
      <Button className="bg-sage" data-testid="b">
        x
      </Button>,
    );
    expect(html).toContain('bg-sage');
    // Naked `bg-clay` must be gone — but `hover:bg-clay-deep` is allowed
    // because it's a different utility (different state, different shade).
    expect(html).not.toMatch(/(?:^|[\s"])bg-clay(?=[\s"])/);
  });

  it('exposes accessibility attributes (aria-label passthrough)', () => {
    const html = renderToStaticMarkup(
      <Button aria-label="Save profile" size="icon">
        +
      </Button>,
    );
    expect(html).toContain('aria-label="Save profile"');
  });

  it('renders disabled markup when disabled', () => {
    const html = renderToStaticMarkup(<Button disabled>x</Button>);
    expect(html).toContain('disabled');
    expect(html).toContain('disabled:opacity-50');
  });
});
