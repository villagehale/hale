// workstream-extract eval fixtures (VIL-419 extraction, graded for VIL-681).
//
// The next-day check-back reads one label: a thread the extraction model left
// `waiting_on_parent` after Hale asked the parent to choose or approve. These turns pin
// that label and the ones that must not carry it. Invented households, places and ids
// only. Pass bars are set here, before the first draw, from the skill's own rules; one
// draw per fixture, and a failed draw is a finding.

const NOW = '2026-10-06T23:10:00.000Z';
const ZONE = 'America/New_York';
const ROBIN = { id: '6f0d6a5e-2b1c-4c1e-9a7f-0a1b2c3d4e01', name: 'Robin', ageMonths: 50 };
const MORGAN = { id: '6f0d6a5e-2b1c-4c1e-9a7f-0a1b2c3d4e02', name: 'Morgan', ageMonths: 182 };
const SWIM_THREAD = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c01';
const CAMP_THREAD = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c02';
const SWIM_OPEN = `- id=${SWIM_THREAD} status=waiting_on_parent title=Fall swim lessons for Robin next=Pick one of the three options children=${ROBIN.id}`;

function turn(over) {
  return {
    now: NOW,
    timeZone: ZONE,
    language: 'en',
    children: over.children ?? [ROBIN],
    events: [],
    parentText: over.parentText,
    haleText: over.haleText,
    openLines: over.openLines ?? '',
  };
}

export const WORKSTREAM_EXTRACT_FIXTURES = [
  {
    // The canonical check-back case: Hale offered options and asked for a pick.
    id: 'find-no-pick',
    input: turn({
      parentText: 'Can you find swim lessons for Robin this fall? Weekends are best.',
      haleText:
        'Found three Saturday options near you: Parent and Tot Swim at Elm Street Pool at 9:15, Aquatics Level 1 at the Riverside Y at 10:30, and Little Splashers at Northside Rec at 11:00. Which one looks good?',
    }),
    expect: { waitingOnParent: true },
  },
  {
    id: 'signup-offer',
    input: turn({
      parentText: 'The Riverside one looks good',
      haleText:
        'Great pick. Aquatics Level 1 at the Riverside Y is 8 Saturdays starting Oct 17. Want me to go ahead and sign Robin up?',
      openLines: SWIM_OPEN,
    }),
    expect: { waitingOnParent: true },
  },
  {
    // A booking finishes the arranging: the skill says never waiting_on_parent.
    id: 'booked-it',
    input: turn({
      parentText: 'Booked the Riverside one myself this morning, thanks!',
      haleText: 'Nice, Robin is all set for Saturdays at 10:30.',
      openLines: SWIM_OPEN,
    }),
    expect: { finished: SWIM_THREAD },
  },
  {
    id: 'not-this-year',
    input: turn({
      parentText: 'Actually we are going to skip swim this year',
      haleText: 'Totally fair. I will leave swim alone for now.',
      openLines: SWIM_OPEN,
    }),
    expect: { declined: SWIM_THREAD },
  },
  {
    id: 'small-talk',
    input: turn({ parentText: 'haha thanks, you are the best', haleText: 'Anytime!' }),
    expect: { none: true },
  },
  {
    // The check-back skips a 13+ child's thread by id, so the id must be on it.
    id: 'teen-ask',
    input: turn({
      children: [ROBIN, MORGAN],
      parentText: 'Can you look for driving lessons for Morgan this winter?',
      haleText:
        'Two winter options: a weekend course at Northside Driving School, or evening classes at Safe Start Driving. Want details on either?',
    }),
    expect: { childId: MORGAN.id },
  },
  {
    // A parent-set check-back belongs to the VIL-419 follow-up, which the check-back skips.
    id: 'check-with-me-friday',
    input: turn({
      parentText: 'Not sure yet about camp, check with me Friday',
      haleText: 'No rush. Friday it is.',
      openLines: `- id=${CAMP_THREAD} status=waiting_on_parent title=March break camp for Robin next=Decide on a camp children=${ROBIN.id}`,
    }),
    expect: { checkBack: true },
  },
];
