/**
 * VIL-566 — the household group, as the onboarding reply reads it.
 *
 * Expectations come from the spec (packages/agent/skills/household-group.md), not from
 * what the model wrote: a yes to the group is not the group. While no group exists, a
 * reply does not say or suggest that setup is done. Once one is claimed, a reply does not
 * say it is still to come. Neither says the other parent has joined.
 *
 * `over` is spread onto a blank FriendVoiceInput. `v2` pins the group-onboarding flag for
 * that fixture, because the co-parent turn reads a different skill set under each.
 */

const DONE_BUT_COPARENT = {
  postal: true,
  kids: true,
  ages: true,
  name: true,
  gmail: true,
  calendar: true,
  schedule: true,
  coparent: false,
};
const ALL_DONE = { ...DONE_BUT_COPARENT, coparent: true };

const FAMILY = {
  parentName: 'Dana',
  agesLabel: 'Mia (4)',
  ageMonths: [48],
  children: [{ name: 'Mia', ageMonths: 48 }],
  // Monday morning on the family's clock.
  now: new Date('2026-11-02T14:00:00Z'),
  timeZone: 'America/New_York',
  scheduled: [],
};

const ASKED_EN = [
  { role: 'parent', body: 'sounds good' },
  {
    role: 'hale',
    body: "Would a group chat with Mia's other parent help, so you both see the same plans and reminders?",
    asked: true,
  },
];

export const HOUSEHOLD_GROUP_FIXTURES = [
  {
    id: 'en-yes-unclaimed-v2',
    v2: true,
    over: {
      ...FAMILY,
      step: 'coparent',
      parentWords: 'yes please',
      language: 'en',
      recentTurns: ASKED_EN,
      checklist: DONE_BUT_COPARENT,
      join: true,
      householdGroup: 'unclaimed',
    },
    watchFor:
      'The yes is the last open item, but no group exists yet. The reply must not say or suggest setup is done or that they are all set. Saying Hale has what it needs for Mia is fine.',
  },
  {
    id: 'en-yes-unclaimed-legacy',
    v2: false,
    over: {
      ...FAMILY,
      step: 'coparent',
      parentWords: 'yeah that would be great',
      language: 'en',
      recentTurns: ASKED_EN,
      checklist: DONE_BUT_COPARENT,
      join: true,
      householdGroup: 'unclaimed',
    },
    watchFor:
      'Code places the number and the phrase under this reply. The group does not exist until they start it, so the reply must not say or suggest setup is done or that everything is in place.',
  },
  {
    id: 'fr-yes-unclaimed-v2',
    v2: true,
    over: {
      ...FAMILY,
      step: 'coparent',
      parentWords: 'oui bonne idée',
      language: 'fr',
      recentTurns: [
        { role: 'parent', body: "d'accord" },
        {
          role: 'hale',
          body: "Est-ce qu'un groupe avec l'autre parent de Mia t'aiderait, pour voir les mêmes plans et rappels ?",
          asked: true,
        },
      ],
      checklist: DONE_BUT_COPARENT,
      join: true,
      householdGroup: 'unclaimed',
    },
    watchFor:
      "French, tu, real accents. No group exists yet: the reply must not say or suggest that everything is set up (no « tout est prêt », « c'est réglé », « tout est en place »).",
  },
  {
    id: 'en-connected-pending',
    v2: true,
    over: {
      ...FAMILY,
      step: 'connected',
      parentWords: '',
      language: 'en',
      connector: 'gcal',
      granted: null,
      synced: { provider: 'gcal', read: 'empty', calendar: [], email: [], overlaps: [] },
      recentTurns: [
        {
          role: 'hale',
          body: "Would a group chat with Mia's other parent help, so you both see the same plans?",
          asked: true,
        },
        { role: 'parent', body: 'yes' },
        { role: 'hale', body: "I'll start the group with you two whenever you're ready." },
      ],
      checklist: ALL_DONE,
      householdGroup: 'pending',
    },
    watchFor:
      'The calendar just connected and every ask is answered, but the group they said yes to does not exist yet. The receipt must not say or suggest setup is done, all set, or everything in place, and must not say the other parent has joined.',
  },
  {
    id: 'en-connected-claimed',
    v2: true,
    over: {
      ...FAMILY,
      step: 'connected',
      parentWords: '',
      language: 'en',
      connector: 'gcal',
      granted: null,
      synced: { provider: 'gcal', read: 'empty', calendar: [], email: [], overlaps: [] },
      recentTurns: [
        { role: 'parent', body: 'yes' },
        { role: 'hale', body: "I'll start the group with you two whenever you're ready." },
      ],
      checklist: ALL_DONE,
      householdGroup: 'claimed',
    },
    watchFor:
      'The group exists. The receipt must not say the group is still to come or still needs setting up, and must not say the other parent has joined or can see anything.',
  },
];
