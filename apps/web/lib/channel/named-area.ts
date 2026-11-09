import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { namesAPerson } from '~/lib/channel/activity/deidentify';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * A place a parent named ("Terrace BC", "somewhere in Vermont"), read by the model into
 * `{ locality, region, granularity }`, then gated in code before any of it is searched.
 *
 * The model decides WHAT the words are: a town, a neighbourhood, a province or state, a
 * street, or not a place. No word list can: "Terrace", "Trail" and "Federal Way" are towns,
 * and "Bayview Drive" and "Wallace St" are streets, and only knowledge of the places tells
 * them apart. Code decides what may LEAVE: a street or a non-place is refused, and each
 * field must hold letters only (no digit, so no house number, postal code or ZIP; no comma
 * or slash, so no second field) and name nobody in the household (rule #1).
 *
 * A neighbourhood is searched by the town it is in, and the neighbourhood's own name never
 * leaves: the model returns only the town as `locality`. A region-grain answer searches the
 * region alone.
 */

export const AREA_GRANULARITIES = [
  'street',
  'neighbourhood',
  'locality',
  'region',
  'not_a_place',
] as const;

export type AreaGranularity = (typeof AREA_GRANULARITIES)[number];

/** What the model read. Not yet searchable: {@link searchableArea} decides that. */
export interface NamedArea {
  /** The town or city. For a neighbourhood, the town it is in. */
  locality: string | null;
  /** The province or state. */
  region: string | null;
  /** What the parent named. */
  granularity: AreaGranularity;
}

export type AreaRefusal = 'area_unusable' | 'area_names_a_person' | 'area_unread';

export type SearchableAreaResult =
  | {
      ok: true;
      area: { locality: string | null; region: string | null };
      /** "Terrace, British Columbia". The only form a search is given. */
      label: string;
    }
  | { ok: false; refusal: AreaRefusal };

export const AREA_READ_TOOL = 'named_area';
export const AREA_READ_MAX_TOKENS = 400;
export const AREA_READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    locality: { type: ['string', 'null'] },
    region: { type: ['string', 'null'] },
    granularity: { type: 'string', enum: [...AREA_GRANULARITIES] },
  },
  required: ['locality', 'region', 'granularity'],
} as const;
export const AREA_READ_TOOL_DESCRIPTION =
  'Return the place the parent named, and what kind of place it is.';

const outputSchema = z.object({
  locality: z.string().nullable(),
  region: z.string().nullable(),
  granularity: z.enum(AREA_GRANULARITIES),
});

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function areaReadUserMessage(text: string): string {
  return JSON.stringify({ place: text });
}

const MAX_FIELD_CHARS = 60;
/** Letters, combining marks, spaces, and `'` `’` `.` `-` — a place name and nothing else. */
const LETTERS_ONLY = /^\p{L}[\p{L}\p{M}\s'’.-]*$/u;

type Field = { ok: true; value: string | null } | { ok: false; refusal: AreaRefusal };

function gateField(raw: string | null, householdNames: readonly string[]): Field {
  const value = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (value === '') return { ok: true, value: null };
  if (namesAPerson(value, householdNames)) return { ok: false, refusal: 'area_names_a_person' };
  if (value.length > MAX_FIELD_CHARS || !LETTERS_ONLY.test(value)) {
    return { ok: false, refusal: 'area_unusable' };
  }
  return { ok: true, value };
}

/** Pure code: what of the model's reading may be searched, or why none of it may. */
export function searchableArea(
  named: NamedArea,
  householdNames: readonly string[],
): SearchableAreaResult {
  if (named.granularity === 'street' || named.granularity === 'not_a_place') {
    return { ok: false, refusal: 'area_unusable' };
  }
  const regionOnly = named.granularity === 'region';
  const locality = regionOnly
    ? { ok: true as const, value: null }
    : gateField(named.locality, householdNames);
  if (!locality.ok) return locality;
  const region = gateField(named.region, householdNames);
  if (!region.ok) return region;
  if ((regionOnly ? region.value : locality.value) === null) {
    return { ok: false, refusal: 'area_unusable' };
  }
  const label = [locality.value, region.value].filter((part) => part !== null).join(', ');
  return { ok: true, area: { locality: locality.value, region: region.value }, label };
}

export interface NamedAreaReader {
  /** Null: the read failed. */
  read(text: string): Promise<NamedArea | null>;
}

export function createNamedAreaReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): NamedAreaReader {
  return {
    async read(text) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('area-read');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: areaReadUserMessage(text),
          toolName: AREA_READ_TOOL,
          toolDescription: AREA_READ_TOOL_DESCRIPTION,
          inputJsonSchema: AREA_READ_TOOL_SCHEMA,
          schema: outputSchema,
          maxTokens: AREA_READ_MAX_TOKENS,
        });
        return value;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'named area: read failed',
        );
        return null;
      }
    },
  };
}

let shared: NamedAreaReader | null = null;

export function sharedNamedAreaReader(): NamedAreaReader {
  shared ??= createNamedAreaReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** Read the place the parent named and gate it. A failed read is `area_unread`: the
 * caller says so, and never falls back to searching around home. */
export async function resolveNamedArea(input: {
  reader: NamedAreaReader;
  text: string;
  householdNames: readonly string[];
}): Promise<SearchableAreaResult> {
  const named = await input.reader.read(input.text);
  if (named === null) return { ok: false, refusal: 'area_unread' };
  return searchableArea(named, input.householdNames);
}
