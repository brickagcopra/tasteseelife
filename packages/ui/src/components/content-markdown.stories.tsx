import type { Story } from '@ladle/react';

import { ContentMarkdown } from './content-markdown';

export default {
  title: 'Primitives / ContentMarkdown',
};

const SAMPLE = `# Welcoming the seasons

A warm, chef-prepared meal is about more than food — it's **hospitality**.

## What to expect

- A friendly check-in
- A dish tailored to _your_ tastes
- Time to talk

| Day | Dish |
| --- | --- |
| Mon | Roast chicken |
| Wed | Lentil soup |

Read our [help center](https://example.com) for more.
`;

export const Basic: Story = () => (
  <div className="p-12 bg-linen">
    <ContentMarkdown markdown={SAMPLE} />
  </div>
);

/**
 * Demonstrates the untrusted-at-render posture: embedded raw HTML (the
 * `<script>` + inline handler) is escaped to text, never executed.
 */
export const SanitizesUntrustedInput: Story = () => (
  <div className="p-12 bg-linen">
    <ContentMarkdown
      markdown={'Safe text <script>alert(1)</script> and a [bad link](javascript:alert(2)).'}
    />
  </div>
);
