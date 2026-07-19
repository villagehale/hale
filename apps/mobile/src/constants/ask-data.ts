import type { ChipTone } from '@/components/ui/tint-chip';
import type { IconName } from '@/components/ui/icon';

/**
 * "Suggestions for you" — the four starter rows on the empty Ask screen (handoff).
 * Each row's `prompt` is sent verbatim to the LIVE coach (POST /api/coach); these are
 * real requests, not canned replies, so what Hale does with them is genuine (an action
 * draft, a quick-log, a Drive lookup). Tone/icon mirror the prototype's tinted chips.
 */
export type AskSuggestion = {
  title: string;
  sub: string;
  icon: IconName;
  tone: ChipTone;
  prompt: string;
  /** The onboarding intent (@hale/types value) this row speaks to, where one maps
   * cleanly — a family that stated it floats this row up (deterministic reorder, no
   * new claim). Omitted when no honest single mapping exists (the log row spans nap +
   * meal; the Drive row maps to no intent). */
  intent?: string;
};

export const ASK_SUGGESTIONS: readonly AskSuggestion[] = [
  {
    title: 'Add the well-baby visit',
    sub: 'Calendar & approval',
    icon: 'calendar',
    tone: 'blue',
    prompt: 'Add the next well-baby visit to my calendar.',
    intent: 'health',
  },
  {
    title: 'Log a quick update',
    sub: 'Nap, meal & mood',
    icon: 'pencil',
    tone: 'yellow',
    prompt: 'Napped 1h 20m and ate most of lunch.',
  },
  {
    title: 'Draft a daycare email',
    sub: 'Late arrival tomorrow',
    icon: 'mail',
    tone: 'red',
    prompt: 'Draft an email to daycare letting them know we will be arriving late tomorrow.',
    intent: 'childcare',
  },
  {
    title: 'Find a document',
    sub: 'Search Google Drive',
    icon: 'file-text',
    tone: 'green',
    prompt: 'Find the daycare waiver form in my Google Drive.',
  },
];
