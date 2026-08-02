import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import type { Municipality, ProgramDomain } from '@hale/db';
import { z } from 'zod';
import { forceToolJson } from '~/lib/pipeline/structured';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { loadVerifyRegistrationWindowSkill } from './skill';

/**
 * VIL-259 — re-verifying one stored registration window against the municipality's
 * own page.
 *
 * THE SHAPE IS THE SAFETY. The model is asked ONLY what the page says; it is never
 * shown the stored dates, so it cannot be led into agreeing with them and cannot be
 * led into "correcting" them. The comparison is then arithmetic in `compareWindow`,
 * which returns confirmed / discrepancy / unverified and NOTHING a caller could
 * apply to a row. That is what makes "never silently change" a property of the
 * types rather than a promise in a prompt.
 *
 * Two gates stand between a model reading and a founder alert:
 *   1. CORROBORATION — the quote the model read the dates out of, and the text that
 *      supplied their YEAR, must both appear in the fetched page. A fabricated date
 *      cannot survive a check that looks for it in the source, and a prior-year date
 *      cannot survive a check that the page states that year (M1's stale-year trap,
 *      made structural).
 *   2. THE CONFIDENCE FLOOR — below it the answer is "couldn't verify", never a
 *      guess and never an alarm. A shaky reading that disagrees with the stored row
 *      is not a discrepancy; it is a reading we do not trust.
 */

/** Every municipality in the dataset registers on Toronto wall-clock time. */
export const REGISTRATION_TIME_ZONE = 'America/Toronto';

/** Below this the reading is not used — in either direction. Same floor as the
 * civic hours parser, for the same reason: better silent than wrong about a time. */
export const MIN_VERIFY_CONFIDENCE = 0.7;

const MAX_TOKENS = 1024;

/** Why a page yielded no dates for the cycle asked about. Each is a real, common
 * state of a municipal page — none of them is an error. */
export type UnfoundReason =
  | 'announced_later'
  | 'different_cycle_only'
  | 'no_year_stated'
  | 'not_published';

/** A date as the page prints it: a local calendar day, and a wall-clock time only
 * where the page actually publishes one. */
export interface PublishedDate {
  date: string;
  time: string | null;
}

/** What the page says, as read by the skill — before any comparison. */
export interface ExtractedWindow {
  found: boolean;
  reason: UnfoundReason | null;
  cycleOnPage: string | null;
  /** The page text that supplies the YEAR for these dates. The stale-year anchor. */
  yearEvidence: string | null;
  preview: PublishedDate | null;
  residentOpen: PublishedDate | null;
  generalOpen: PublishedDate | null;
  evidence: string | null;
  confidence: number;
}

/** The stored row under review. A read-only projection of registration_windows —
 * deliberately not the row type, so nothing here can be handed back to an update. */
export interface StoredWindow {
  id: string;
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  previewAt: Date | null;
  residentOpenAt: Date | null;
  openAt: Date;
  sourceUrl: string;
  verifiedAt: Date;
}

export type VerifyField = 'previewAt' | 'residentOpenAt' | 'openAt';

/** One field where the page and the stored row disagree. Carries both instants so
 * a human can read them; carries no instruction. */
export interface FieldDiff {
  field: VerifyField;
  stored: Date | null;
  published: Date;
}

export type UnverifiedReason =
  | UnfoundReason
  | 'low_confidence'
  | 'uncorroborated'
  | 'no_dates_for_cycle'
  | 'fetch_failed'
  | 'extract_failed';

/**
 * The three outcomes, and the whole contract of this module.
 *
 * `confirmed` is the ONLY one that earns a write, and the only write it earns is
 * `verified_at`. `discrepancy` deliberately has no field a caller could spread onto
 * an update — the dates live inside `diffs`, next to the stored value they differ
 * from, which is a shape you read rather than apply.
 */
export type VerifyOutcome =
  | { kind: 'confirmed'; fields: VerifyField[] }
  | { kind: 'discrepancy'; diffs: FieldDiff[]; evidence: string }
  | { kind: 'unverified'; reason: UnverifiedReason };

/**
 * The instant a published date names. A date with no published time is the START of
 * that local day — the seed's own convention, and the only reading that asserts no
 * time the town did not print.
 */
export function publishedInstant(published: PublishedDate): Date {
  return zonedLocalInstant(published.date, published.time ?? '00:00', REGISTRATION_TIME_ZONE);
}

/** Fold away the differences an HTML strip and a re-typed quote legitimately
 * introduce — case, unicode dashes and quotes, runs of whitespace — while keeping
 * every digit and letter. A wrong DATE cannot survive this; a re-typed dash can. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Every four-digit year mentioned in a run of text. */
function yearsIn(text: string): Set<string> {
  return new Set(text.match(/\b(19|20)\d{2}\b/g) ?? []);
}

/**
 * Whether a reading is backed by the fetched page. Binary, like the civic hours
 * gate: there is no partial credit for a date that is nearly in the source.
 *
 * Checks, in the order they can fail:
 *   - the quote the dates were read from appears in the page;
 *   - the text supplying the year appears in the page;
 *   - that text actually states the year every published date claims.
 *
 * The last one is the stale-year trap made structural. A model that rolls last
 * year's table forward has to produce a year the page does not state for that
 * cycle, and cannot.
 */
export function corroborationFailure(
  pageText: string,
  extracted: ExtractedWindow,
): 'uncorroborated' | null {
  if (!extracted.found) return null;

  const page = normalize(pageText);
  const evidence = extracted.evidence;
  const yearEvidence = extracted.yearEvidence;
  if (!evidence || !yearEvidence) return 'uncorroborated';
  if (!page.includes(normalize(evidence))) return 'uncorroborated';
  if (!page.includes(normalize(yearEvidence))) return 'uncorroborated';

  const statedYears = yearsIn(yearEvidence);
  for (const published of [extracted.preview, extracted.residentOpen, extracted.generalOpen]) {
    if (published && !statedYears.has(published.date.slice(0, 4))) {
      return 'uncorroborated';
    }
  }
  return null;
}

/** The stored counterpart of each published field. */
const FIELD_MAP = [
  ['preview', 'previewAt'],
  ['residentOpen', 'residentOpenAt'],
  ['generalOpen', 'openAt'],
] as const satisfies ReadonlyArray<readonly [keyof ExtractedWindow, VerifyField]>;

/**
 * Compare what the page publishes with what is stored.
 *
 * ONLY THE FIELDS THE PAGE STATES ARE COMPARED. A field the page is silent about is
 * not evidence of anything — Toronto prints only its resident date and derives the
 * general open from a written rule, so demanding all three would make its rows
 * permanently unverifiable while proving nothing.
 */
export function compareWindow(stored: StoredWindow, extracted: ExtractedWindow): VerifyOutcome {
  if (!extracted.found) {
    return { kind: 'unverified', reason: extracted.reason ?? 'not_published' };
  }
  // The floor is checked BEFORE the comparison on purpose: a reading we do not
  // trust must not be able to raise an alarm either.
  if (extracted.confidence < MIN_VERIFY_CONFIDENCE) {
    return { kind: 'unverified', reason: 'low_confidence' };
  }

  const matched: VerifyField[] = [];
  const diffs: FieldDiff[] = [];

  for (const [source, field] of FIELD_MAP) {
    const published = extracted[source] as PublishedDate | null;
    if (published === null) continue;
    const publishedAt = publishedInstant(published);
    const storedAt = stored[field];
    if (storedAt !== null && storedAt.getTime() === publishedAt.getTime()) {
      matched.push(field);
    } else {
      diffs.push({ field, stored: storedAt, published: publishedAt });
    }
  }

  if (matched.length === 0 && diffs.length === 0) {
    return { kind: 'unverified', reason: 'no_dates_for_cycle' };
  }
  if (diffs.length > 0) {
    return { kind: 'discrepancy', diffs, evidence: extracted.evidence ?? '' };
  }
  return { kind: 'confirmed', fields: matched };
}

// ── the model read ───────────────────────────────────────────────────────────

const publishedDateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});

const extractionSchema = z.object({
  found: z.boolean(),
  reason: z
    .enum(['announced_later', 'different_cycle_only', 'no_year_stated', 'not_published'])
    .nullable(),
  cycle_on_page: z.string().nullable(),
  year_evidence: z.string().nullable(),
  preview: publishedDateSchema.nullable(),
  resident_open: publishedDateSchema.nullable(),
  general_open: publishedDateSchema.nullable(),
  evidence: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/** What the MODEL sees. Hand-written alongside the Zod schema above, which is what
 * validates what comes back — the same split the civic hours parser uses. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    reason: {
      type: ['string', 'null'],
      enum: ['announced_later', 'different_cycle_only', 'no_year_stated', 'not_published', null],
    },
    cycle_on_page: { type: ['string', 'null'] },
    year_evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text stating the YEAR these dates belong to.',
    },
    preview: { $ref: '#/$defs/publishedDate' },
    resident_open: { $ref: '#/$defs/publishedDate' },
    general_open: { $ref: '#/$defs/publishedDate' },
    evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text the dates were read from.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'found',
    'reason',
    'cycle_on_page',
    'year_evidence',
    'preview',
    'resident_open',
    'general_open',
    'evidence',
    'confidence',
  ],
  $defs: {
    publishedDate: {
      type: ['object', 'null'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: {
          type: ['string', 'null'],
          description: '24-hour HH:MM, or null when the page publishes no time',
        },
      },
      required: ['date', 'time'],
    },
  },
} as const;

/** The user-message payload. Exported so the eval sends the model byte-identical
 * input to what production sends (the eval replicates, never imports). */
export function extractionInput(
  window: Pick<StoredWindow, 'municipality' | 'programDomain' | 'cycleLabel'>,
  pageText: string,
): string {
  return JSON.stringify({
    municipality: window.municipality,
    program_domain: window.programDomain,
    cycle_label: window.cycleLabel,
    page_text: pageText,
  });
}

/** What identifies the cycle to read — all the model is told about the stored row.
 * Deliberately NOT the dates: a model shown the answer cannot be a check on it. */
export type CycleIdentity = Pick<StoredWindow, 'municipality' | 'programDomain' | 'cycleLabel'>;

export interface ExtractDeps {
  client: AgentClient;
}

/** Normalise the skill's snake_case answer into the module's shape. */
export function toExtractedWindow(value: z.infer<typeof extractionSchema>): ExtractedWindow {
  return {
    found: value.found,
    reason: value.reason,
    cycleOnPage: value.cycle_on_page,
    yearEvidence: value.year_evidence,
    preview: value.preview,
    residentOpen: value.resident_open,
    generalOpen: value.general_open,
    evidence: value.evidence,
    confidence: value.confidence,
  };
}

/**
 * Read the dates one municipal page publishes for one stored cycle.
 *
 * The skill is loaded OUTSIDE any catch (as in parseCivicHours): a missing skill
 * file is a deploy bug and must surface as one, never degrade into "this town
 * publishes nothing".
 */
export async function extractPublishedWindow(
  cycle: CycleIdentity,
  pageText: string,
  deps: ExtractDeps,
): Promise<ExtractedWindow> {
  const skill = await loadVerifyRegistrationWindowSkill();
  const { value } = await forceToolJson({
    client: deps.client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage: extractionInput(cycle, pageText),
    toolName: 'published_registration_window',
    toolDescription: 'Return the registration dates this page publishes for the named cycle.',
    inputJsonSchema: EXTRACTION_JSON_SCHEMA,
    schema: extractionSchema,
    maxTokens: MAX_TOKENS,
  });
  return toExtractedWindow(value);
}

/**
 * Whether a reading is one we may act on at all: corroborated by the page, above
 * the confidence floor, and actually a find. The discovery leg's gate — the verify
 * leg additionally runs `compareWindow`, which applies the same floor.
 */
export function isTrustworthyFind(pageText: string, extracted: ExtractedWindow): boolean {
  return (
    extracted.found &&
    extracted.confidence >= MIN_VERIFY_CONFIDENCE &&
    corroborationFailure(pageText, extracted) === null
  );
}
