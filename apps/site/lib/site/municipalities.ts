/**
 * The GTA municipalities the registration radar tracks by name — every one backed
 * by verified registration_windows rows in prod.
 *
 * One list, one count. The landing and /for-centres state the count from
 * `length` and do not render the names. The FAQ names the same number in
 * prose. They used to disagree by construction — the landing was data-driven while
 * two sentences spelled "fifteen" by hand — so a sixteenth town would have made
 * the site contradict itself. Anything that states the count reads it from here.
 */
export const MUNICIPALITIES = [
  'Toronto',
  'Mississauga',
  'Brampton',
  'Markham',
  'Vaughan',
  'Richmond Hill',
  'Oakville',
  'Burlington',
  'Halton Hills',
  'Caledon',
  'Ajax',
  'Pickering',
  'Whitby',
  'Oshawa',
  'Aurora',
  'Stouffville',
  'Newmarket',
  'King',
  'East Gwillimbury',
  'Georgina',
  'Uxbridge',
] as const;

/** How many towns the radar watches — the number every surface must print. */
export const MUNICIPALITY_COUNT = MUNICIPALITIES.length;
