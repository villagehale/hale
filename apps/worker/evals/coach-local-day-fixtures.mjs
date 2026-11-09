// VIL-435 · the family-local day and weather, as the coach reasons over them.
//
// Each case is one texted ask, on one real calendar date, in one place. The picks are
// what `find_activities` hands back: weekly programs whose pages say nothing about
// holiday hours, which is exactly the shape of the 2026-10-12 live bug (a weekly Monday
// drop-in recommended on Canadian Thanksgiving). Places and venues are fictional except
// the cities, and no child is named (the repo is public).
//
// `rubric` is graded by MEANING by a judge, never by word matching: there is no line the
// reply must contain. `broken` is the reply that must FAIL its rubric (calibration).

const TODDLER = {
  id: 'child-toddler',
  stage: 'toddler',
  name: null,
  ageMonths: 26,
  teenRedacted: false,
};

const OTTAWA = { city: 'Ottawa', province: 'ON', country: 'CA' };
const COLUMBUS = { city: 'Columbus', province: 'OH', country: 'US' };

const mondayPicks = [
  {
    name: 'Little Movers drop-in',
    ageFit: '1 to 4 years',
    when: 'Mondays 9:30 to 11:30 a.m.',
    price: 'Free',
    sourceName: "Riverbend Community Centre's program page",
    source: 'web',
    url: 'https://riverbend-cc.example.org/programs/little-movers',
  },
  {
    name: 'Toddler story time',
    ageFit: '18 months to 3 years',
    when: 'Mondays 10:30 a.m.',
    price: 'Free',
    sourceName: "Willow Branch Library's events page",
    source: 'web',
    url: 'https://willow-branch-library.example.org/events/toddler-story-time',
  },
];

const thursdayPicks = mondayPicks.map((pick) => ({
  ...pick,
  when: pick.when.replace('Mondays', 'Thursdays'),
}));

const saturdayPicks = [
  {
    name: 'Toddler nature walk (outdoor trail)',
    ageFit: '2 to 5 years',
    when: 'Saturdays 10 a.m., outdoors on the park trail',
    price: 'Free',
    sourceName: "Cedar Park Conservancy's events page",
    source: 'web',
    url: 'https://cedar-park.example.org/events/toddler-nature-walk',
  },
  {
    name: 'Indoor open play gym',
    ageFit: '1 to 5 years',
    when: 'Saturdays 9 a.m. to noon, indoors',
    price: '$6 per child',
    sourceName: "Riverbend Community Centre's program page",
    source: 'web',
    url: 'https://riverbend-cc.example.org/programs/open-play',
  },
];

const mild = (date, weekday) => ({ date, weekday, precipitationChancePct: 10, highTempC: 14 });

const HOLIDAY_RUBRIC = (holiday) =>
  [
    `Today is ${holiday} where this family lives. Both picks are weekly programs on today's`,
    'weekday and their pages say nothing about holiday hours. PASS (4-5): the reply does not',
    'present either program as running today without flagging the day. It recognises the',
    'holiday (naming it, or plainly calling today a holiday) and says, in any words, that',
    'places may be closed or on holiday hours and are worth checking before going, or it',
    'hands over something only with that caveat. FAIL (1-2): it recommends a weekly program',
    'for today as if it is certainly running, with no holiday or closure caveat, or it',
    'invents opening hours or a confirmation the picks do not give.',
  ].join(' ');

export const COACH_LOCAL_DAY_FIXTURES = [
  {
    id: 'ca-thanksgiving-today',
    note: 'The live bug, frozen: 10:07 on Canadian Thanksgiving (an Ontario statutory holiday).',
    now: '2026-10-12T14:07:20.000Z',
    timeZone: 'America/Toronto',
    location: OTTAWA,
    child: TODDLER,
    text: 'Find me something to do today',
    forecast: [mild('2026-10-12', 'Monday'), mild('2026-10-13', 'Tuesday')],
    picks: mondayPicks,
    rubric: HOLIDAY_RUBRIC('Thanksgiving Day in Canada (a statutory holiday in Ontario)'),
    broken:
      'Little Movers drop-in at Riverbend Community Centre runs Mondays 9:30 to 11:30, free for 1 to 4. Worth a go this morning.',
  },
  {
    id: 'us-thanksgiving-today',
    note: 'A US family on US Thanksgiving: the same shape, a different country and day.',
    now: '2026-11-26T15:00:00.000Z',
    timeZone: 'America/New_York',
    location: COLUMBUS,
    child: TODDLER,
    text: 'Find me something to do today',
    forecast: [mild('2026-11-26', 'Thursday'), mild('2026-11-27', 'Friday')],
    picks: thursdayPicks,
    rubric: HOLIDAY_RUBRIC('Thanksgiving Day in the United States (a federal holiday)'),
    broken:
      'Little Movers drop-in at Riverbend Community Centre runs Thursdays 9:30 to 11:30, free for 1 to 4. Worth a go this morning.',
  },
  {
    id: 'ordinary-monday',
    note: 'An ordinary Monday a week later: behaviour must not change.',
    now: '2026-10-19T14:07:20.000Z',
    timeZone: 'America/Toronto',
    location: OTTAWA,
    child: TODDLER,
    text: 'Find me something to do today',
    forecast: [mild('2026-10-19', 'Monday'), mild('2026-10-20', 'Tuesday')],
    picks: mondayPicks,
    rubric: [
      'Today is an ordinary Monday where this family lives: no public holiday. PASS (4-5): the',
      'reply hands over at least one of the Monday picks for today plainly, using only the',
      "picks' own times. FAIL (1-2): it invents a holiday, warns that places may be closed for",
      'a holiday, or withholds the picks.',
    ].join(' '),
    broken:
      "It's a holiday today, so most places are closed and Little Movers likely isn't running. Maybe stay in?",
  },
  {
    id: 'rainy-saturday',
    note: 'A wet, cold Saturday: the forecast should tip the pick indoors.',
    now: '2026-11-14T14:30:00.000Z',
    timeZone: 'America/Toronto',
    location: OTTAWA,
    child: TODDLER,
    text: 'what should we do today?',
    forecast: [
      { date: '2026-11-14', weekday: 'Saturday', precipitationChancePct: 90, highTempC: 6 },
      { date: '2026-11-15', weekday: 'Sunday', precipitationChancePct: 20, highTempC: 8 },
    ],
    picks: saturdayPicks,
    rubric: [
      "Today's forecast is a 90% chance of rain and a high of 6C. PASS (4-5): the reply leads",
      'with or clearly prefers the indoor open play gym, and any weather it mentions agrees',
      'with that forecast. FAIL (1-2): it leads with the outdoor trail walk as the plan for',
      'today with no regard for the rain, or it claims weather the forecast does not give.',
    ].join(' '),
    broken:
      'Try the toddler nature walk on the Cedar Park trail at 10. A nice way to burn off energy outside.',
  },
  {
    id: 'nice-saturday',
    note: 'A pleasant Saturday: outdoor picks stay on the table.',
    now: '2026-05-16T14:30:00.000Z',
    timeZone: 'America/Toronto',
    location: OTTAWA,
    child: TODDLER,
    text: 'what should we do today?',
    forecast: [
      { date: '2026-05-16', weekday: 'Saturday', precipitationChancePct: 5, highTempC: 22 },
      { date: '2026-05-17', weekday: 'Sunday', precipitationChancePct: 10, highTempC: 21 },
    ],
    picks: saturdayPicks,
    rubric: [
      "Today's forecast is a 5% chance of rain and a high of 22C. PASS (4-5): the outdoor trail",
      'walk is offered (as the lead or alongside the indoor gym) and the reply raises no rain,',
      'cold or bad-weather warning. FAIL (1-2): it steers the family away from outdoors because',
      'of bad weather, or claims weather the forecast does not give.',
    ].join(' '),
    broken:
      'It looks wet and cold out, so skip the trail. The indoor open play gym is your best bet today.',
  },
];
