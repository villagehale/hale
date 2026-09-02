/**
 * The GTA municipalities the registration radar tracks by name — every one backed
 * by verified registration_windows rows in prod.
 *
 * One list, one count. The landing renders the names and derives its heading count
 * from `length`; the FAQ and the landing's radar lede name the same number in
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
] as const;

/** How many towns the radar watches — the number every surface must print. */
export const MUNICIPALITY_COUNT = MUNICIPALITIES.length;
