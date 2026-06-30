/**
 * PLACEHOLDER per-child guide data. NOT real and NOT from any API. Immunization
 * names follow the publicly published Health Canada / NACI infant schedule for
 * realism only — not medical guidance.
 */

export type TimelineKind = 'checkup' | 'immunization' | 'milestone' | 'log';

export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  when: string;
  detail: string;
  upcoming: boolean;
};

export type CompanionChild = {
  id: string;
  name: string;
  ageMonths: number;
  ageLabel: string;
  stage: string;
  timeline: TimelineEntry[];
};

export const COMPANION_CHILDREN: CompanionChild[] = [
  {
    id: 'anaya',
    name: 'Anaya',
    ageMonths: 3,
    ageLabel: '3 mo',
    stage: 'Newborn',
    timeline: [
      {
        id: 'a-checkup-4m',
        kind: 'checkup',
        title: '4-month well-baby visit',
        when: 'in 3 days',
        detail: 'Growth check, feeding review, development screen.',
        upcoming: true,
      },
      {
        id: 'a-imm-4m',
        kind: 'immunization',
        title: '4-month immunizations',
        when: 'in 3 days',
        detail: 'DTaP-IPV-Hib, pneumococcal, rotavirus (Health Canada schedule).',
        upcoming: true,
      },
      {
        id: 'a-mile-roll',
        kind: 'milestone',
        title: 'Rolling over',
        when: 'window now',
        detail: 'Many babies roll front-to-back around 3-4 months.',
        upcoming: true,
      },
      {
        id: 'a-log-feed',
        kind: 'log',
        title: 'Fed 120ml',
        when: '11:40am today',
        detail: 'Bottle, finished within 20 min.',
        upcoming: false,
      },
      {
        id: 'a-log-nap',
        kind: 'log',
        title: 'Nap 1h 25m',
        when: '9:10am today',
        detail: 'Down easily, woke calm.',
        upcoming: false,
      },
      {
        id: 'a-imm-2m',
        kind: 'immunization',
        title: '2-month immunizations',
        when: '5 weeks ago',
        detail: 'Completed on schedule.',
        upcoming: false,
      },
    ],
  },
  {
    id: 'theo',
    name: 'Theo',
    ageMonths: 24,
    ageLabel: '2 yr',
    stage: 'Toddler',
    timeline: [
      {
        id: 't-mile-words',
        kind: 'milestone',
        title: 'Two-word phrases',
        when: 'window now',
        detail: 'Combining words like "more milk" is typical around 24 months.',
        upcoming: true,
      },
      {
        id: 't-checkup-18m',
        kind: 'checkup',
        title: '18-month well-child visit',
        when: 'completed',
        detail: 'Development on track; revisit at 2-3 years.',
        upcoming: false,
      },
      {
        id: 't-log-nap',
        kind: 'log',
        title: 'Nap 1h 50m',
        when: '1:15pm today',
        detail: 'One nap; settling earlier than last week.',
        upcoming: false,
      },
    ],
  },
];
