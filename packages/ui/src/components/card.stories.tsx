import type { Story } from '@ladle/react';

import { Button } from './button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

export default {
  title: 'Primitives / Card',
};

export const Basic: Story = () => (
  <div className="p-12 bg-linen">
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Companion dining, this Tuesday</CardTitle>
        <CardDescription>
          Chef Naomi will prepare your mother&apos;s short-rib ragu and stay through dessert.
          Estimated arrival 5:45pm.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-ink">
          You&apos;ll receive a wellness summary by 9pm with notes on appetite, mood, and
          conversation highlights.
        </p>
      </CardContent>
      <CardFooter>
        <Button>Confirm visit</Button>
        <Button variant="ghost">Reschedule</Button>
      </CardFooter>
    </Card>
  </div>
);

export const HeaderOnly: Story = () => (
  <div className="p-12 bg-linen">
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Memory meal library</CardTitle>
        <CardDescription>Five new recipes added this week.</CardDescription>
      </CardHeader>
    </Card>
  </div>
);
