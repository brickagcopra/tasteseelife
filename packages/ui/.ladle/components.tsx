import type { GlobalProvider } from '@ladle/react';
import { useEffect } from 'react';

import '../src/styles/ladle.css';

/**
 * Ladle GlobalProvider — wraps every story.
 *
 * Adds a `Senior mode` toggle in Ladle's toolbar (`controls.seniorMode`)
 * that flips `data-senior-mode` on `<html>`. The design-tokens CSS layer
 * picks up the override block automatically — there's no per-story
 * decoration needed.
 *
 * Type scale and motion follow the same hinge: when senior-mode is on,
 * `--ts-text-scale` becomes 1.5 and `--ts-motion-multiplier` becomes 0,
 * so transitions collapse and text grows uniformly across all primitives.
 */
export const Provider: GlobalProvider = ({ children, globalState }) => {
  const seniorMode = globalState.control['seniorMode']?.value === true;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (seniorMode) {
      root.setAttribute('data-senior-mode', 'on');
    } else {
      root.removeAttribute('data-senior-mode');
    }
  }, [seniorMode]);

  return <>{children}</>;
};

/**
 * Default global controls — exposed in Ladle's toolbar across all stories.
 * Toggle "Senior mode" to verify each primitive responds to the AAA-contrast
 * + tap-target + motion hinges (CLAUDE §8.3).
 */
export const argTypes = {
  seniorMode: {
    control: { type: 'boolean' },
    defaultValue: false,
    description: 'Toggle senior-mode hinges (data-senior-mode="on" on <html>).',
  },
};
