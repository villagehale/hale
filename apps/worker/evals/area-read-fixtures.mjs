/**
 * VIL-546 · Area read fixtures. Each `text` is a place a parent named, as the runtime hands
 * it to the `area-read` skill (apps/web/lib/channel/named-area.ts). `expect` is what the
 * runtime's own gate (`searchableArea`) must then do with the model's reading:
 *   - `{ refusal }`: nothing is searched;
 *   - `{ locality, region }`: searched, each an accepted spelling list (or null for none).
 * Towns whose names end in a street word are the reason the word lists went.
 */

export const AREA_READ_FIXTURES = [
  {
    id: 'town-terrace-bc',
    text: 'Terrace BC',
    expect: { locality: ['Terrace'], region: ['British Columbia'] },
  },
  {
    id: 'town-trail-bc',
    text: 'Trail, BC',
    expect: { locality: ['Trail'], region: ['British Columbia'] },
  },
  {
    id: 'town-federal-way-wa',
    text: 'Federal Way WA',
    expect: { locality: ['Federal Way'], region: ['Washington'] },
  },
  {
    id: 'town-college-place-wa',
    text: 'College Place, Washington',
    expect: { locality: ['College Place'], region: ['Washington'] },
  },
  {
    id: 'town-st-catharines',
    text: 'St. Catharines',
    expect: {
      locality: ['St. Catharines', 'St Catharines', 'Saint Catharines'],
      region: ['Ontario'],
    },
  },
  {
    id: 'town-french-qc',
    text: 'Saint-Jérôme, QC',
    expect: { locality: ['Saint-Jérôme', 'St-Jérôme'], region: ['Quebec', 'Québec'] },
  },
  {
    id: 'street-bayview-drive-on',
    text: 'Bayview Drive, ON',
    expect: { refusal: 'area_unusable' },
  },
  {
    id: 'street-wallace-st-bc',
    text: 'Wallace St BC',
    expect: { refusal: 'area_unusable' },
  },
  {
    id: 'street-maple-lane-ontario',
    text: 'Maple Lane Ontario',
    expect: { refusal: 'area_unusable' },
  },
  {
    id: 'street-elm-court-bc',
    text: 'Elm Court BC',
    expect: { refusal: 'area_unusable' },
  },
  {
    id: 'neighbourhood-searched-by-town',
    text: 'the South Hill area of Spokane',
    expect: { locality: ['Spokane'], region: ['Washington'] },
  },
  {
    id: 'region-vermont',
    text: 'somewhere in Vermont',
    expect: { locality: null, region: ['Vermont'] },
  },
  {
    id: 'not-a-place',
    text: 'the park by our house',
    expect: { refusal: 'area_unusable' },
  },
];

/** Invented names: a household the gate checks every field against. */
export const AREA_READ_HOUSEHOLD = ['Mila', 'Theo'];
