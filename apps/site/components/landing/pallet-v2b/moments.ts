/**
 * The seven cards — seven real things Hale does, one card each, in the order a
 * family meets them. Nothing here is invented: every line is Hale's own product
 * copy, traced below to the file it came from.
 *
 *   packages/agent/skills/*.md          the voice rules each line obeys
 *   the F14 product tour (hale-tour-v2) the shipped example thread
 *   apps/site/components/landing/chief-of-staff.tsx   the live page's claims
 *
 * The names (Max, Mia), the town (Halton Hills) and the dates are the tour's own
 * worked example, and the page labels them as an example — the same honesty
 * device the live page uses on its first-conversation card.
 *
 * `lead` marks the centre card. It gets the three-phase entrance; the other six
 * are revealed in its wake.
 */

export type CardBubble = { from: 'parent' | 'hale'; text: string };

export type Moment = {
  id: string;
  /** Slot 0-6, left to right in the fan. */
  slot: number;
  tag: string;
  tone: 'amber' | 'navy' | 'berry';
  /** Screen-reader name for the card; never rendered visually. */
  label: string;
  bubbles?: readonly CardBubble[];
  /** A quiet factual footnote under the thread. */
  note?: string;
  /** The calendar card's ICS attachment row. */
  ics?: { title: string; when: string };
  /** The weekly-brief card, which is an email rather than a text. */
  brief?: { stamp: string; title: string; rows: readonly string[] };
  lead?: true;
};

export const MOMENTS: readonly Moment[] = [
  {
    id: 'coaching',
    slot: 0,
    tag: 'the 3 a.m. question',
    tone: 'amber',
    label: 'Coaching: a question answered in the same thread',
    bubbles: [
      { from: 'parent', text: 'Mia keeps waking at 3am and ending up in our bed - help?' },
      {
        from: 'hale',
        text: 'At 18 months that is really common, and what turns it around is consistency - settle her in her own bed with the same calm words.',
      },
    ],
  },
  {
    id: 'method',
    slot: 1,
    tag: 'the method, by name',
    tone: 'navy',
    label: 'The plan: a named, source-verified method',
    bubbles: [
      {
        from: 'hale',
        text: 'It is the Ferber method - graduated check-ins, the best-studied approach there is. Keep each check short and boring, and wait a little longer before the next one.',
      },
      { from: 'hale', text: 'I will check in Friday.' },
    ],
    note: 'Never a dose, never a diagnosis.',
  },
  {
    id: 'natural',
    slot: 2,
    tag: 'no keywords',
    tone: 'berry',
    label: 'Natural replies: Hale reads what you actually wrote',
    bubbles: [
      { from: 'parent', text: 'max has a bday party sat 2pm at riverdale farm' },
      { from: 'hale', text: "Add Max's birthday party - Sat, Aug 23 at 2pm, Riverdale Farm?" },
      { from: 'parent', text: 'yeah go ahead' },
    ],
  },
  {
    id: 'radar',
    slot: 3,
    lead: true,
    tag: 'the first reply',
    tone: 'amber',
    label: 'The radar: the first reply is a real registration date',
    bubbles: [
      { from: 'parent', text: 'Max is 4, Mia is 18 months, L7G 4S8' },
      {
        from: 'hale',
        text: 'I checked for Max and Mia - Halton Hills opens fall rec registration Tuesday, Sep 1 at 7 a.m., and as residents you get a 7-day head start.',
      },
    ],
  },
  {
    id: 'calendar',
    slot: 4,
    tag: 'you approved it',
    tone: 'navy',
    label: 'The calendar invite, sent only after you said yes',
    bubbles: [
      {
        from: 'hale',
        text: 'Done - it is on your calendar. I have emailed you an invite your calendar can add in one tap, no account to connect.',
      },
    ],
    ics: { title: "Max's birthday party", when: 'Sat, Aug 23 at 2:00 PM' },
  },
  {
    id: 'intro',
    slot: 5,
    tag: 'both say yes',
    tone: 'berry',
    label: 'A family introduction, double opt-in',
    bubbles: [
      {
        from: 'hale',
        text: "There is another Hale family nearby with a kid around Max's age, and something on this Saturday you could both drop into. Want me to make an introduction?",
      },
    ],
    note: 'Nothing about either family is shared until you both say yes.',
  },
  {
    id: 'brief',
    slot: 6,
    tag: 'monday morning',
    tone: 'navy',
    label: 'The weekly brief, one quiet email',
    brief: {
      stamp: 'Monday',
      title: 'Your week',
      rows: ["What's booked", 'What needs a decision', 'The whole family week, one page'],
    },
  },
] as const;

/** The lead card's slot — the centre of the fan, and the card that enters first. */
export const LEAD_SLOT = 3;
