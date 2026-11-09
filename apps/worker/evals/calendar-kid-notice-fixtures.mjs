// The 1:1 kid calendar notice (VIL-570) — the corpus.
//
// Expectations come from the SPEC: the `calendar_kid_change` paragraph of
// packages/agent/skills/spoken-line.md. The writer is handed the change, the event, the
// kid and the times, already formatted the way apps/web/lib/integrations/calendar-alert.ts
// formats them. A reason, a reschedule, a make-up session or an offer to act is invention.

const INVENTED =
  /\b(because|due to|weather|sick|ill|instead|make[- ]?up|refund|want me to|should I|I can)\b/i;
const INVENTED_FR =
  /\b(parce que|à cause|météo|malade|rattrap|rembours|veux-tu que|voulez-vous que)\b/i;

export const CALENDAR_KID_NOTICE_FIXTURES = [
  {
    id: 'cancelled-single',
    request: {
      purpose: 'calendar_kid_change',
      language: 'en',
      facts: {
        change: 'cancelled',
        event: 'Swim lesson',
        kid: 'Leo',
        day: 'Sat, Sep 19',
        time: '10:00',
        end_time: '10:45',
      },
    },
    mustMention: [/swim/i, /cancel/i, /sat|sep 19|19/i],
    watchFor:
      "Leo's swim lesson on Saturday Sep 19 at 10:00 is cancelled. Nothing about why, no make-up, no offer.",
    forbiddenPatterns: [INVENTED],
  },
  {
    id: 'moved-single',
    request: {
      purpose: 'calendar_kid_change',
      language: 'en',
      facts: {
        change: 'moved',
        event: 'Piano',
        kid: 'Ada',
        day: 'Thu, Sep 24',
        time: '16:30',
        end_time: '17:15',
        was_day: 'Wed, Sep 23',
        was_time: '16:30',
      },
    },
    mustMention: [/piano/i, /thu|sep 24|24/i],
    watchFor:
      "Ada's piano moved from Wednesday Sep 23 to Thursday Sep 24, same time 4:30. It must name the new day; the old day is welcome. No reason.",
    forbiddenPatterns: [INVENTED],
  },
  {
    id: 'series-cancelled',
    request: {
      purpose: 'calendar_kid_change',
      language: 'en',
      facts: {
        change: 'cancelled',
        event: 'Soccer practice',
        day: 'Tue, Sep 22',
        time: '17:00',
        end_time: '18:00',
        sessions: '3',
      },
    },
    mustMention: [/soccer/i, /cancel/i, /3|three/i],
    watchFor:
      'Three soccer practice sessions are cancelled, the first on Tuesday Sep 22. No kid is named in the facts, so none may be named or guessed.',
    forbiddenPatterns: [INVENTED, /\b(he|she|his|her|son|daughter)\b/i],
  },
  {
    id: 'cancelled-french',
    request: {
      purpose: 'calendar_kid_change',
      language: 'fr',
      facts: {
        change: 'cancelled',
        event: 'Natation',
        kid: 'Léa',
        day: 'sam. 19 sept.',
        time: '10:00',
        end_time: '10:45',
      },
    },
    mustMention: [/natation/i, /annul/i],
    watchFor:
      "In French, with accents: Léa's Natation on Saturday Sep 19 is cancelled. No English.",
    forbiddenPatterns: [INVENTED_FR, /\bcancelled\b/i],
  },
  {
    id: 'moved-all-day',
    request: {
      purpose: 'calendar_kid_change',
      language: 'en',
      facts: {
        change: 'moved',
        event: 'Field trip',
        kid: 'Noor',
        day: 'Fri, Oct 2',
        was_day: 'Thu, Oct 1',
      },
    },
    mustMention: [/field trip/i, /fri|oct 2|2/i],
    watchFor:
      "Noor's field trip moved from Thursday Oct 1 to Friday Oct 2. It is all day: no clock time may appear.",
    forbiddenPatterns: [INVENTED, /\d{1,2}:\d{2}|\b\d{1,2}\s?(am|pm|a\.m\.|p\.m\.)/i],
  },
];
