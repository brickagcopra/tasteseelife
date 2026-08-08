import type { ArgTypes, Story } from '@ladle/react';

import { Button, type ButtonProps } from './button';

export default {
  title: 'Primitives / Button',
};

export const Primary: Story<ButtonProps> = (args) => <Button {...args}>Primary</Button>;
Primary.args = { variant: 'primary', size: 'md' } satisfies ButtonProps;

export const Ghost: Story<ButtonProps> = (args) => <Button {...args}>Ghost</Button>;
Ghost.args = { variant: 'ghost', size: 'md' } satisfies ButtonProps;

export const Outline: Story<ButtonProps> = (args) => <Button {...args}>Outline</Button>;
Outline.args = { variant: 'outline', size: 'md' } satisfies ButtonProps;

export const LinkVariant: Story<ButtonProps> = (args) => <Button {...args}>Read more →</Button>;
LinkVariant.args = { variant: 'link', size: 'md' } satisfies ButtonProps;

export const Sizes: Story = () => (
  <div className="flex items-center gap-3 p-6 bg-paper">
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Add">
      +
    </Button>
  </div>
);

export const States: Story = () => (
  <div className="flex items-center gap-3 p-6 bg-paper">
    <Button>Default</Button>
    <Button disabled>Disabled</Button>
  </div>
);

export const ControlsArgTypes: ArgTypes<ButtonProps> = {
  variant: {
    options: ['primary', 'ghost', 'outline', 'link'],
    control: { type: 'select' },
    defaultValue: 'primary',
  },
  size: {
    options: ['sm', 'md', 'lg', 'icon'],
    control: { type: 'select' },
    defaultValue: 'md',
  },
  disabled: { control: { type: 'boolean' }, defaultValue: false },
};

Primary.argTypes = ControlsArgTypes;
Ghost.argTypes = ControlsArgTypes;
Outline.argTypes = ControlsArgTypes;
LinkVariant.argTypes = ControlsArgTypes;
