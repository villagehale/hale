import type { FamilyStage } from '@hale/types';

/**
 * Stage chips on /answers. `param` is the `?stage=` value. School age is the
 * `child` family stage; the URL says school-age so the query reads as the chip.
 */
export const GUIDE_STAGE_FILTERS = [
  { stage: 'newborn', param: 'newborn', label: 'Newborn', range: '0–11 months' },
  { stage: 'toddler', param: 'toddler', label: 'Toddler', range: '1–3 years' },
  { stage: 'child', param: 'school-age', label: 'School age', range: '4–12 years' },
  { stage: 'teenager', param: 'teenager', label: 'Teenager', range: '13+ years' },
] as const satisfies readonly {
  stage: FamilyStage;
  param: string;
  label: string;
  range: string;
}[];

export type GuideStageParam = (typeof GUIDE_STAGE_FILTERS)[number]['param'];

const PARAMS: readonly string[] = GUIDE_STAGE_FILTERS.map((stage) => stage.param);

export function guideStageFilter(stage: FamilyStage) {
  return GUIDE_STAGE_FILTERS.find((item) => item.stage === stage);
}

/** A known `?stage=` value, or null when the query is absent or not a chip. */
export function filterStageFromSearch(
  search: string,
  known: readonly string[] = PARAMS,
): string | null {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('stage');
  if (raw && known.includes(raw)) return raw;
  return null;
}

/** The same URL with `stage` set, or removed for All. Other params stay. */
export function hrefWithStage(href: string, param: string | null): string {
  const url = new URL(href, 'http://local');
  if (param) url.searchParams.set('stage', param);
  else url.searchParams.delete('stage');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Pressing the chip that is already selected leaves the filter where it is. */
export function nextFilterStage(current: string | null, pressed: string | null): string | null {
  return pressed === current ? current : pressed;
}

export function fillCount(template: string, values: Record<string, number | string>): string {
  return Object.entries(values).reduce(
    (line, [key, value]) => line.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

/** "Showing n of total guides", plus the stage name when a chip is selected. */
export function filterStatusLine(
  template: string,
  shown: number,
  total: number,
  stageLabel: string | null,
): string {
  const line = fillCount(template, { n: shown, total });
  return stageLabel ? `${line}: ${stageLabel}` : line;
}

/** Anchor id for a guide section heading. Stable, unique within one page. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
