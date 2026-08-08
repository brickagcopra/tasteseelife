import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '../dialog';

describe('Dialog exports', () => {
  it('exposes Radix root primitives', () => {
    expect(Dialog).toBeDefined();
    expect(DialogTrigger).toBeDefined();
    expect(DialogPortal).toBeDefined();
    expect(DialogClose).toBeDefined();
    expect(DialogOverlay).toBeDefined();
    expect(DialogContent).toBeDefined();
    expect(DialogTitle).toBeDefined();
    expect(DialogDescription).toBeDefined();
  });

  it('DialogHeader wraps children in a column flex container', () => {
    const html = renderToStaticMarkup(<DialogHeader>x</DialogHeader>);
    expect(html).toContain('flex-col');
    expect(html).toContain('gap-2');
  });

  it('DialogFooter stacks on mobile and rows on sm+', () => {
    const html = renderToStaticMarkup(<DialogFooter>x</DialogFooter>);
    expect(html).toContain('flex-col-reverse');
    expect(html).toContain('sm:flex-row');
  });

  it('DialogTrigger renders as a button when used without asChild', () => {
    const html = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
      </Dialog>,
    );
    expect(html).toContain('Open');
    expect(html).toMatch(/<button[^>]*>Open<\/button>/);
  });
});
