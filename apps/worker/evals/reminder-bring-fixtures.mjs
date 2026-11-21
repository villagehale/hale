// The reminder with what to bring (VIL-720) — the corpus.
//
// Each fixture is the input to `reminderFacts` (apps/web/lib/loop/reminders/compose.ts) with
// an event carrying `bringItems`, the list the 1:1 reminder hands its owner. The writer is
// the REAL reminder skill with the `reminder-bring` addendum appended, exactly as
// production composes once an event carries a list. A judge reads facts only; `watchFor`
// names the list so a dropped or an added item scores low. Every name, place and item is
// invented.

const TZ = 'America/Toronto';
const KID = { id: 'c-kid', name: 'Léa', dateOfBirth: '2019-04-02', gender: 'girl' };

function ev(over) {
  return { eventRef: 'e1', childId: null, sensitive: false, location: null, endsAt: null, ...over };
}

function args(over) {
  return {
    children: [KID],
    level: 'first_name',
    timeZone: TZ,
    offset: '-P1D',
    // Friday 6:00 PM EST.
    now: '2026-11-20T23:00:00Z',
    planLink: null,
    language: 'en',
    ...over,
  };
}

export const REMINDER_BRING_FIXTURES = [
  {
    id: 'en-evening-swim-bring',
    args: args({
      events: [
        ev({
          title: 'Swim lessons',
          childId: KID.id,
          startsAt: '2026-11-21T14:30:00Z',
          endsAt: '2026-11-21T15:15:00Z',
          location: 'Riverside Pool, 40 Lake Rd',
          bringItems: ['a swimsuit', 'a towel', 'goggles'],
        }),
      ],
    }),
    watchFor:
      "Léa's swim lesson tomorrow (Saturday) 9:30 to 10:15 AM at Riverside Pool, 40 Lake Rd. The facts carry bringItems from the organizer's own email: a swimsuit, a towel and goggles. Every one of the three must be in the text as something to bring for the swim lesson; a missing item is a LOW score (1-2), and so is any item that is not one of those three (sunscreen, a snack, a swim cap...). Saying these three items is NOT an invented detail: they are given facts. Also check the day, both times with AM/PM, the venue name and the street address.",
  },
  {
    id: 'fr-hour-before-skate-bring',
    args: args({
      language: 'fr',
      offset: '-PT1H',
      // Saturday 9:12 AM EST, 48 minutes before the start.
      now: '2026-11-21T14:12:00Z',
      events: [
        ev({
          title: 'Cours de patinage',
          childId: KID.id,
          startsAt: '2026-11-21T15:00:00Z',
          endsAt: '2026-11-21T15:45:00Z',
          location: 'Aréna Saint-Michel, 12 rue Principale',
          bringItems: ['vos patins', 'un casque', "une bouteille d'eau"],
        }),
      ],
    }),
    watchFor:
      "Léa's skating class starts in 48 minutes, at 10:00 AM (10 h), until 10:45, at Aréna Saint-Michel, 12 rue Principale. In French. The facts carry bringItems from the organizer: skates (patins), a helmet (casque) and a water bottle (bouteille d'eau). All three must be in the text; a missing one is a LOW score (1-2), and any other item is an invented detail and a LOW score. Saying these three is NOT an invented detail. A relative time that does not match 48 minutes is a wrong time.",
  },
  {
    id: 'en-evening-two-events-one-list',
    args: args({
      events: [
        ev({
          eventRef: 'e1',
          title: 'Picture day',
          childId: KID.id,
          startsAt: '2026-11-21T14:00:00Z',
          endsAt: '2026-11-21T15:00:00Z',
          location: 'Maple Grove Public School, 8 Birch Ave',
          bringItems: ['their school uniform'],
        }),
        ev({
          eventRef: 'e2',
          title: 'Library storytime',
          startsAt: '2026-11-21T18:30:00Z',
          endsAt: '2026-11-21T19:15:00Z',
          location: 'Georgetown Branch, 9 Church St',
        }),
      ],
    }),
    watchFor:
      "Two things tomorrow: Léa's Picture day 9:00 to 10:00 AM at Maple Grove Public School, 8 Birch Ave, and Library storytime 1:30 to 2:15 PM at Georgetown Branch, 9 Church St. Only Picture day carries bringItems: the school uniform (wearing it counts). The uniform must be in the text with Picture day; a missing uniform is a LOW score (1-2). Storytime has no list: tying the uniform to storytime, or saying anything to bring for storytime, is an invented detail and a LOW score. Nothing overlaps.",
  },
];

// Each is a believable reply with ONE defect on the list the judge must catch.
export const REMINDER_BRING_BROKEN_CASES = [
  {
    fixtureId: 'en-evening-swim-bring',
    tag: 'en-evening-swim-bring:drops-goggles',
    body: "Léa's swim lesson is tomorrow 9:30 to 10:15 AM at Riverside Pool, 40 Lake Rd. Pack her swimsuit and a towel.",
  },
  {
    fixtureId: 'fr-hour-before-skate-bring',
    tag: 'fr-hour-before-skate-bring:adds-mittens',
    body: "Le cours de patinage de Léa commence dans 48 minutes, à 10 h, jusqu'à 10 h 45, à l'Aréna Saint-Michel, 12 rue Principale. Apporte ses patins, son casque, une bouteille d'eau et des mitaines.",
  },
  {
    fixtureId: 'en-evening-two-events-one-list',
    tag: 'en-evening-two-events-one-list:list-on-wrong-event',
    body: 'Léa has Picture day tomorrow 9 to 10 AM at Maple Grove Public School, 8 Birch Ave.\nThen Library storytime 1:30 to 2:15 PM at Georgetown Branch, 9 Church St: wear the school uniform.',
  },
];
