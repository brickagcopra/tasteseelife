import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ContentMarkdown } from '../content-markdown';

function render(markdown: string): string {
  return renderToStaticMarkup(<ContentMarkdown markdown={markdown} />);
}

describe('ContentMarkdown', () => {
  it('renders headings and paragraphs from Markdown', () => {
    const html = render('# Hello\n\nA warm chef-prepared meal.');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('A warm chef-prepared meal.');
  });

  it('renders a GFM table', () => {
    const html = render('| Dish | Day |\n| --- | --- |\n| Soup | Mon |');
    expect(html).toContain('<table>');
    expect(html).toContain('Soup');
  });

  it('wraps output in the .content-markdown container', () => {
    expect(render('text')).toContain('class="content-markdown"');
  });

  it('forces rel="noopener noreferrer" on links and opens external links in a new tab', () => {
    const html = render('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('does not add target=_blank for relative links', () => {
    const html = render('[local](/help/getting-started)');
    expect(html).toContain('href="/help/getting-started"');
    expect(html).not.toContain('target="_blank"');
  });

  it('escapes embedded raw HTML instead of rendering it (no rehype-raw)', () => {
    const html = render('before <script>alert(1)</script> after');
    // The <script> is escaped to text, never emitted as a live tag.
    expect(html).not.toContain('<script>');
    expect(html).toContain('alert(1)');
  });

  it('strips a javascript: link protocol via the sanitize allow-list', () => {
    const html = render('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('does not emit an onerror handler from an image', () => {
    const html = render('![alt](https://example.com/x.png)');
    expect(html).not.toContain('onerror');
  });
});
