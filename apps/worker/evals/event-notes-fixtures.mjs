// VIL-468. The event-notes reader's corpus: real-world calendar descriptions, mostly
// UNLABELLED, so a label parser could not pass it. `expect` says in prose what the
// description states; a judge scores the reading by MEANING (no word lists).

export const EVENT_NOTES_FIXTURES = [
  {
    id: 'en-prose-parking-bring',
    title: 'U9 hockey practice',
    description:
      "Hi all! Ice time is at the Westview arena this week, rink 2. The main lot is closed for repaving so please park on Dunlop St or in the church lot across the road. Kids should come dressed except skates, and don't forget a full water bottle — no sharing. Coach Dave 416-555-0182",
    expect: {
      parking: 'Park on Dunlop St or in the church lot across the road; the main lot is closed.',
      bring: 'Come dressed except skates; a full water bottle.',
    },
  },
  {
    id: 'en-html-buried',
    title: 'Grade 3 field trip — Science Centre',
    description:
      '<p>Permission forms were due Friday.</p><p>Buses leave the school at 8:45 sharp. Please pack a <b>nut-free</b> lunch in a disposable bag and send your child with a hat &amp; sunscreen already applied.</p><p>Volunteers: we still need 2!</p>',
    expect: {
      parking: null,
      bring: 'A nut-free lunch in a disposable bag, and a hat (sunscreen applied beforehand).',
    },
  },
  {
    id: 'fr-prose',
    title: 'Natation – cours du samedi',
    description:
      "Bonjour les parents! Le stationnement du centre est payant cette session, mais vous pouvez vous garer gratuitement rue Beaubien après 9 h. N'oubliez pas le bonnet de bain (obligatoire) et des lunettes si votre enfant en a. Merci!",
    expect: {
      parking:
        'The centre lot is paid this session; free parking on rue Beaubien after 9 h (kept in French).',
      bring: 'A swim cap (mandatory) and goggles if the child has them (kept in French).',
      language: 'fr',
    },
  },
  {
    id: 'en-none-stated',
    title: 'Swim lesson',
    description: 'Level 3 with Coach Priya. Reminder: no lessons on Thanksgiving weekend.',
    expect: { parking: null, bring: null },
    trap: 'A swim lesson invites inferring a towel or swimsuit; none is stated.',
  },
  {
    id: 'en-no-parking-onsite',
    title: 'Birthday party — Maya turns 7',
    description:
      "We'd love to see you! There's no parking at the venue itself (it's on a pedestrian street), the Green P on Queen is closest. Gifts are totally optional. RSVP to Jen by text.",
    expect: {
      parking: 'No parking at the venue; the Green P on Queen is closest.',
      bring: null,
    },
    trap: 'Gifts are optional, so they are not a thing to bring.',
  },
  {
    id: 'en-other-event',
    title: 'Piano lesson',
    description:
      'For the spring recital in May, parents will park in the lower lot and each student brings two copies of their piece. Today is a regular lesson.',
    expect: { parking: null, bring: null },
    trap: 'The parking and bring facts belong to a different event (the recital), not this lesson.',
  },
];

/** --broken stand-in: invents facts and drops the French, so the judge must fail it. */
export const BROKEN_READING = {
  parking: 'Free parking available on site.',
  bring: 'Towel, swimsuit, water bottle and snacks.',
};
