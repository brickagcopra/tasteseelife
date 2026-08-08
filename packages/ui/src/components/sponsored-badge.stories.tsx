import type { Story } from '@ladle/react';

import { Card, CardContent, CardHeader, CardTitle } from './card';
import { SponsoredBadge } from './sponsored-badge';

export default {
  title: 'Primitives / SponsoredBadge',
};

export const Basic: Story = () => (
  <div className="p-12 bg-linen">
    <SponsoredBadge />
  </div>
);

/**
 * In situ on a provider result row — the disclosure sits beside the organic
 * "Featured" boost (a clay-filled accent) to show the two read as distinct: a
 * paid placement vs. an editorial boost. A row may carry both.
 */
export const OnAResultRow: Story = () => (
  <div className="p-12 bg-linen">
    <Card className="max-w-md">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Chef Naomi A.</CardTitle>
          <div className="flex items-center gap-2">
            <SponsoredBadge />
            <span className="inline-block rounded-full bg-clay px-2.5 py-0.5 font-sans text-xs font-semibold uppercase tracking-wide text-paper">
              Featured
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-ink-soft">
          Elite Concierge · Mediterranean, dementia-sensitive dining · Upper East Side
        </p>
      </CardContent>
    </Card>
  </div>
);
