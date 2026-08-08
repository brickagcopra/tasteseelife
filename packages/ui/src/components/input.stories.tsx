import type { Story } from '@ladle/react';

import { Input, type InputProps } from './input';

export default {
  title: 'Primitives / Input',
};

export const Default: Story<InputProps> = (args) => (
  <div className="p-12 bg-linen max-w-md">
    <label
      htmlFor="email"
      className="block font-mono text-xs uppercase tracking-widest text-ink-soft mb-2"
    >
      Email
    </label>
    <Input id="email" type="email" placeholder="you@example.com" {...args} />
  </div>
);

export const Invalid: Story<InputProps> = (args) => (
  <div className="p-12 bg-linen max-w-md">
    <label
      htmlFor="email-bad"
      className="block font-mono text-xs uppercase tracking-widest text-ink-soft mb-2"
    >
      Email
    </label>
    <Input
      id="email-bad"
      type="email"
      defaultValue="not-an-email"
      invalid
      aria-describedby="email-bad-help"
      {...args}
    />
    <p id="email-bad-help" className="mt-2 text-sm text-clay-deep">
      Please enter a valid email address.
    </p>
  </div>
);

export const Disabled: Story = () => (
  <div className="p-12 bg-linen max-w-md">
    <Input placeholder="Disabled" disabled />
  </div>
);

Default.argTypes = {
  invalid: { control: { type: 'boolean' }, defaultValue: false },
  disabled: { control: { type: 'boolean' }, defaultValue: false },
  placeholder: { control: { type: 'text' }, defaultValue: 'you@example.com' },
};
