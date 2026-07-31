// VIL-245 · M10 birthday-party extraction corpus.
//
// PII (rule #1): every message here is synthetic. The names are invented, the addresses
// are shaped like addresses but belong to nobody, and nothing in the corpus came from a
// real family.
//
// Expectations are derived from the SPEC (packages/agent/skills/party-extraction.md) —
// the 14:00 default, the next-occurrence year rule, the "null rather than guess" rule,
// and the hosting-vs-attending distinction are what the skill SAYS, not what the model
// happened to answer.
//
// The clock is PINNED so relative phrasing is deterministic. RECEIVED_AT is a Monday
// morning in Toronto; every "this Saturday" below resolves against it.

/** Monday 2026-07-20, 09:00 America/Toronto. */
export const RECEIVED_AT = '2026-07-20T13:00:00Z';
export const FAMILY_TIMEZONE = 'America/Toronto';

/**
 * `expect.startsAt` is an ISO instant (compared as an INSTANT, so any equivalent offset
 * passes) or `null` where the skill must refuse to guess. `expect.isParty: false` means
 * every other field must be null.
 *
 * `hostingTrap: true` marks the battery that must NEVER read as a party the parent is
 * hosting — a false positive there is Hale offering to publish a page with someone
 * else's child's address on it.
 */
export const PARTY_FIXTURES = [
  {
    id: 'clean-full',
    message: "Max's 5th birthday, Aug 23, 2pm, our place",
    expect: {
      isParty: true,
      titleIncludes: ['Max'],
      startsAt: '2026-08-23T14:00:00-04:00',
      location: 'our place',
      childName: 'Max',
    },
  },
  {
    id: 'no-time-uses-the-documented-default',
    // The skill pins 14:00 local for a stated date with no time. A guessed 09:00 would
    // put fifteen households on a doorstep five hours early.
    message: "Leo's birthday party on September 12, at the community pool",
    expect: {
      isParty: true,
      titleIncludes: ['Leo'],
      startsAt: '2026-09-12T14:00:00-04:00',
      location: 'the community pool',
      childName: 'Leo',
    },
  },
  {
    id: 'relative-this-saturday',
    message: "we're doing Ana's birthday party this Saturday at 11am, our backyard",
    expect: {
      isParty: true,
      titleIncludes: ['Ana'],
      startsAt: '2026-07-25T11:00:00-04:00',
      location: 'our backyard',
      childName: 'Ana',
    },
  },
  {
    id: 'year-rolls-forward',
    // "Jan 4" received in July is next January, never a date four months in the past.
    message: "Max's birthday party Jan 4, 2pm, our place",
    expect: {
      isParty: true,
      titleIncludes: ['Max'],
      startsAt: '2027-01-04T14:00:00-05:00',
      location: 'our place',
      childName: 'Max',
    },
  },
  {
    id: 'no-location-stays-null',
    message: "Max's 6th birthday party Aug 15 at 3pm",
    expect: {
      isParty: true,
      titleIncludes: ['Max'],
      startsAt: '2026-08-15T15:00:00-04:00',
      location: null,
      childName: 'Max',
    },
  },
  {
    id: 'partial-address-not-completed',
    // "14 Elm" must come back as "14 Elm". A completed address is a wrong address.
    message: "Ana's birthday party, Sept 5, 1pm, 14 Elm",
    expect: {
      isParty: true,
      titleIncludes: ['Ana'],
      startsAt: '2026-09-05T13:00:00-04:00',
      location: '14 Elm',
      childName: 'Ana',
    },
  },
  {
    id: 'unnamed-child-stays-null',
    message: "my son's birthday party Aug 30 at 1pm at the park",
    expect: {
      isParty: true,
      startsAt: '2026-08-30T13:00:00-04:00',
      location: 'the park',
      childName: null,
    },
  },
  {
    id: 'vague-month-refuses',
    // "sometime in August" is not a date. Hale asks one question instead.
    message: 'planning a birthday thing for Ana sometime in August, probably the park',
    expect: { isParty: true, startsAt: null },
  },
  {
    id: 'no-date-at-all-refuses',
    message: "throwing Max a birthday party at Jump Zone, I'll confirm the day",
    expect: { isParty: true, startsAt: null },
  },
  {
    id: 'attending-not-hosting',
    hostingTrap: true,
    message: "Leo's birthday party is Saturday, we're going",
    expect: { isParty: false },
  },
  {
    id: 'gift-for-someone-elses-party',
    hostingTrap: true,
    message: "remind me to buy a gift for Leo's party on the weekend",
    expect: { isParty: false },
  },
  {
    id: 'birthday-with-no-party',
    hostingTrap: true,
    message: 'Max turns 5 tomorrow!',
    expect: { isParty: false },
  },
];

// DELIBERATELY NOT A FIXTURE: a bare "Ana's birthday, Sept 5, 1pm, 14 Elm" — date, time
// and an address with no word saying who is throwing it. It was tried as a hosting trap
// and the model split on it across runs, which is the honest answer: the message really
// is 50/50, and a human reading it could not tell either. Pinning one sample of a coin
// flip as a gate would make this suite assert a behaviour the skill does not have.
//
// It is safe to leave undecided because the stakes downstream are bounded: `is_party:
// true` on an ambiguous message costs the parent ONE offer they can ignore, not a
// published page — nothing is public until they reply YES (apps/web/lib/party/reply.ts).
// The genuinely unambiguous traps above are what this suite gates on.
