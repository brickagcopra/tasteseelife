'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { TriggerEmergencyAssistanceRequestSchema } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { triggerEmergencyAssistance } from '@/lib/concierge-emergency-api';

/**
 * Trigger emergency concierge assistance (TS-225).
 *
 * Reads the category + optional note, re-validates against the canonical
 * schema (the page boundary is a security boundary), and triggers via the
 * gateway with a fresh Idempotency-Key. service-concierge resolves the
 * household from the token, opens a high-severity escalated ticket, and pages
 * the on-call supervisor. Outcomes funnel through the one-shot flash channel
 * + a redirect back to the emergency page so the protected-layout banner
 * surfaces the result.
 */
export async function triggerEmergencyAction(formData: FormData): Promise<void> {
  const page = '/concierge/emergency';

  const category = readString(formData, 'category');
  const note = readString(formData, 'note');

  const candidate: Record<string, unknown> = { category };
  if (note.length > 0) candidate['note'] = note;

  const validated = TriggerEmergencyAssistanceRequestSchema.safeParse(candidate);
  if (!validated.success) {
    await setFlash({ kind: 'error', code: 'concierge_emergency.invalid' });
    redirect(page);
  }

  const result = await triggerEmergencyAssistance(validated.data, randomUUID());
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'concierge_emergency.failed' });
    redirect(page);
  }

  await setFlash({ kind: 'success', code: 'concierge_emergency.triggered' });
  redirect(page);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
