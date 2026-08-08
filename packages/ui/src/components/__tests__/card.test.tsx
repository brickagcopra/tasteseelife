import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../card';

describe('Card composition', () => {
  it('Card emits the canonical chrome (border + paper + rounded)', () => {
    const html = renderToStaticMarkup(<Card>body</Card>);
    expect(html).toContain('border-rule');
    expect(html).toContain('bg-paper');
    expect(html).toContain('rounded-lg');
  });

  it('CardTitle renders an h3 in the serif family', () => {
    const html = renderToStaticMarkup(<CardTitle>Title</CardTitle>);
    expect(html).toMatch(/^<h3/);
    expect(html).toContain('font-serif');
  });

  it('CardDescription uses ink-soft for secondary copy', () => {
    const html = renderToStaticMarkup(<CardDescription>desc</CardDescription>);
    expect(html).toMatch(/^<p/);
    expect(html).toContain('text-ink-soft');
  });

  it('full composition renders nested children in order', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Hello</CardTitle>
          <CardDescription>World</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Foot</CardFooter>
      </Card>,
    );
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('World'));
    expect(html.indexOf('World')).toBeLessThan(html.indexOf('Body'));
    expect(html.indexOf('Body')).toBeLessThan(html.indexOf('Foot'));
  });

  it('caller className wins on conflicting Tailwind utilities', () => {
    const html = renderToStaticMarkup(<Card className="bg-sage">x</Card>);
    expect(html).toContain('bg-sage');
    expect(html).not.toContain('bg-paper');
  });
});
