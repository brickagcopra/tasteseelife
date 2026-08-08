import type { Story } from '@ladle/react';

import { Button } from './button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { Input } from './input';

export default {
  title: 'Primitives / Dialog',
};

export const Basic: Story = () => (
  <div className="p-12 bg-linen min-h-[60vh] flex items-start">
    <Dialog>
      <DialogTrigger asChild>
        <Button>Add a memory recipe</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a memory recipe</DialogTitle>
          <DialogDescription>
            We&apos;ll save this to your loved one&apos;s memory meal library so any chef on a
            future visit can prepare it from your notes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <label
            htmlFor="recipe-title"
            className="font-mono text-xs uppercase tracking-widest text-ink-soft"
          >
            Recipe name
          </label>
          <Input id="recipe-title" placeholder="Grandma&rsquo;s short-rib ragu" />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
);

export const NoCloseButton: Story = () => (
  <div className="p-12 bg-linen min-h-[60vh] flex items-start">
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Confirm cancellation</Button>
      </DialogTrigger>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>Cancel Tuesday&rsquo;s visit?</DialogTitle>
          <DialogDescription>
            Chef Naomi will be notified. Cancellations within 24 hours of the visit incur a 50% fee
            per the booking policy.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Keep visit</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button>Cancel visit</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
);
