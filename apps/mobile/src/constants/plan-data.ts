/**
 * PLACEHOLDER week-ahead data. NOT real and NOT from any API.
 */

export type PlanItemKind = 'activity' | 'routine' | 'checkup' | 'immunization' | 'milestone';

export type PlanItem = {
  id: string;
  kind: PlanItemKind;
  title: string;
  detail: string;
  child?: string;
};

export type PlanDay = {
  id: string;
  label: string;
  date: string;
  items: PlanItem[];
};

export const PLAN_WEEK: PlanDay[] = [
  {
    id: 'mon',
    label: 'Monday',
    date: 'Jun 30',
    items: [
      {
        id: 'mon-routine',
        kind: 'routine',
        title: 'Morning walk + nap wind-down',
        detail: 'Gentle recurring routine for Anaya.',
      },
    ],
  },
  {
    id: 'tue',
    label: 'Tuesday',
    date: 'Jul 1',
    items: [
      {
        id: 'tue-activity',
        kind: 'activity',
        title: 'Baby Time at the library',
        detail: '10:30am · endorsed by the village.',
      },
    ],
  },
  {
    id: 'wed',
    label: 'Wednesday',
    date: 'Jul 2',
    items: [
      {
        id: 'wed-checkup',
        kind: 'checkup',
        title: '4-month well-baby visit',
        detail: 'Dr. Okafor, 2:15pm.',
        child: 'Anaya',
      },
      {
        id: 'wed-imm',
        kind: 'immunization',
        title: '4-month immunizations',
        detail: 'DTaP-IPV-Hib, pneumococcal, rotavirus.',
        child: 'Anaya',
      },
    ],
  },
  {
    id: 'thu',
    label: 'Thursday',
    date: 'Jul 3',
    items: [
      {
        id: 'thu-mile',
        kind: 'milestone',
        title: 'Two-word phrases',
        detail: 'Watch for word combinations this week.',
        child: 'Theo',
      },
    ],
  },
  {
    id: 'fri',
    label: 'Friday',
    date: 'Jul 4',
    items: [
      {
        id: 'fri-activity',
        kind: 'activity',
        title: 'Harbourfront stroller walk',
        detail: 'Daylight · endorsed by the village.',
      },
    ],
  },
];
