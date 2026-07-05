import Anthropic from '@anthropic-ai/sdk';
import { type Database, schema } from '@hale/db';
import { type FamilyStage, deriveStage } from '@hale/types';
import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { loadCoachModel } from '~/lib/coach/model';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { loadDiscoveryPrompt } from './discovery-prompt';
import { type GeocodeResult, type LatLng, geocodeArea, geocodeVenue } from './geocode';
import type { Season } from './visibility';

/**
 * Web-side, on-demand village discovery. The scheduled worker job
 * (`runVillageDiscovery`) only runs where the worker is deployed; this mirrors
 * its logic so a signed-in family can populate `/village` from the web app. We
 * replicate the worker's flow (read coarse area, derive non-teen stages, call
 * the model, persist + audit) rather than import it: the worker's agent and
 * memory-writer reach into its own internal modules, neither exported nor
 * importable across the process boundary. The two things that COULD drift — the
 * discovery prompt and the model id — are read from the worker's own files at
 * request time (discovery-prompt.ts / coach/model.ts).
 *
 * Spend bound (one call): a single forced-tool extraction over general
 * knowledge, NOT the worker's two-phase web-grounded path (that runs behind a
 * worker config flag). One Anthropic call per discovery, for the family's
 * primary (youngest) non-teen stage.
 *
 * Privacy (rule #1): only the COARSE area + stage + interests reach the model —
 * never a child name, DOB, or precise location (the model never receives one and
 * the row schema has no column for one). Teen children (13+) are excluded at the
 * source (selectDiscoveryInputs), so a teenager's stage is never queried and
 * their interests never enter the pool.
 *
 * Audit (rule #6): the candidate insert and ONE audit_log row commit in a single
 * transaction; the audit `after` carries only the coarse area, provider label,
 * and a count — never raw candidate text or location.
 */

/** Candidates carry no category column; persisted under one honest label
 * (mirrors the worker's CANDIDATE_KIND). */
const CANDIDATE_KIND = 'activity';

/** Provenance label for web-side general-knowledge discovery; honest that these
 * rest on the model's general knowledge, not a live grounding URL. Mirrors the
 * worker provider's `llm_only` source value. */
const SOURCE = 'llm_only';

/** Hosts the model reaches for when it has no real URL — adopting one sends a
 * parent to a placeholder, not the venue. Reject them so the register link falls
 * back to a coarse-area search instead. */
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'localhost']);

/**
 * A model-supplied source URL is a fallback we adopt ONLY when Places has no
 * verified website. It's often guessed, so we keep it only when it's an absolute
 * http(s) URL whose host isn't an obvious placeholder; anything else becomes null
 * (the register link then uses its coarse-area Google-search fallback). We never
 * synthesize a URL.
 */
export function sanitizeModelUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (PLACEHOLDER_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return trimmed;
}

/** Max candidates the model is asked for; matches the worker's DEFAULT_LIMIT. */
export const DISCOVERY_LIMIT = 8;

export const DISCOVERY_TOOL = 'submit_candidates';

const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;

export const candidatesSchema = z.object({
  candidates: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      cadence: z.enum(['seasonal', 'one-time', 'ongoing']).optional(),
      eventDate: z.string().optional(),
      seasons: z.array(z.enum(SEASONS)).optional(),
      sourceUrl: z.string().optional(),
      confidence: z.number().min(0).max(1),
      coverageNote: z.string(),
    }),
  ),
});

export const candidatesJsonSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          cadence: { type: 'string', enum: ['seasonal', 'one-time', 'ongoing'] },
          eventDate: { type: 'string' },
          seasons: { type: 'array', items: { type: 'string', enum: [...SEASONS] } },
          sourceUrl: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          coverageNote: { type: 'string' },
        },
        required: ['title', 'description', 'confidence', 'coverageNote'],
      },
    },
  },
  required: ['candidates'],
} as const;

export type DiscoveryAnthropicClient = Pick<Anthropic, 'messages'>;

export interface DiscoverDeps {
  client: DiscoveryAnthropicClient;
  loadPrompt: () => Promise<string>;
  loadModel: () => Promise<string>;
  /** Best-effort venue geocode for the map pin. Resolves a candidate's title to
   * PUBLIC coordinates using the family's COARSE area only (rule #1), or null for
   * an online / no-venue activity or an unresolved lookup. `bias` is the coarse
   * area centre, biasing the lookup so a same-named venue in another city doesn't
   * win the pin. Never throws. */
  geocode: (
    title: string,
    areaCoarse: string,
    bias?: LatLng,
  ) => Promise<GeocodeResult | null>;
  /** Best-effort centroid of the COARSE area (rule #1) used to bias venue
   * lookups, or null when it can't be resolved (then geocode falls back to the
   * text-only search). Never throws. */
  geocodeArea: (areaCoarse: string) => Promise<LatLng | null>;
}

export type DiscoverResult =
  | { status: 'discovered'; insertedCount: number }
  | { status: 'no_area' }
  | { status: 'no_non_teen_children' };

/**
 * The discovery inputs for a family, derived from NON-TEEN children only
 * (rule #1). Empty `stages` means there is nothing to discover — the caller
 * skips the model call entirely. Replicates the worker's selectDiscoveryInputs;
 * stages are childhood-ordered so the "primary" stage is the youngest.
 */
const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

export function selectDiscoveryInputs(
  children: ReadonlyArray<{ dateOfBirth: string | Date; interests: string[] }>,
  now: Date = new Date(),
): { stages: FamilyStage[]; interests: string[] } {
  const nonTeen = children.filter((c) => deriveStage(c.dateOfBirth, now) !== 'teenager');
  const present = new Set<FamilyStage>(nonTeen.map((c) => deriveStage(c.dateOfBirth, now)));
  const stages = STAGE_ORDER.filter((stage) => present.has(stage));
  const interests = [...new Set(nonTeen.flatMap((c) => c.interests))];
  return { stages, interests };
}

function defaultLoadModel(): Promise<string> {
  return loadCoachModel();
}

/**
 * Optional scoping for a discovery run. Absent → a STANDING run: the weekly feed
 * (run_type 'standing'). Present → a SEARCH run scoped to `searchSeason`: rows are
 * tagged run_type 'search' + the season, `season_hint` is passed to the model (the
 * discovery prompt already documents that input — rule #2, no prompt change), and
 * the supersession is scoped so a search run never soft-retires the standing feed
 * (and a standing run never soft-retires a search) — the two coexist.
 */
export interface DiscoverOptions {
  searchSeason?: Season;
}

/**
 * Runs on-demand discovery for one family and persists the result. Returns a
 * status the caller surfaces in the UI; never throws on the two expected
 * boundaries (no coarse area, no non-teen children) — those are valid states,
 * not errors. A genuine model/db failure bubbles up (rule #8: don't mask).
 */
export async function discoverForFamily(
  familyId: string,
  database: Database,
  deps: DiscoverDeps,
  options?: DiscoverOptions,
): Promise<DiscoverResult> {
  const searchSeason = options?.searchSeason ?? null;
  const runType = searchSeason ? 'search' : 'standing';
  const familyRows = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const family = familyRows[0];
  if (!family) {
    throw new Error(`discoverForFamily: no family row for ${familyId}`);
  }
  if (!family.areaCoarse) {
    return { status: 'no_area' };
  }
  const areaCoarse = family.areaCoarse;

  const childRows = await database
    .select({
      dateOfBirth: schema.children.dateOfBirth,
      interests: schema.children.interests,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const { stages, interests } = selectDiscoveryInputs(childRows);
  const primaryStage = stages[0];
  if (!primaryStage) {
    return { status: 'no_non_teen_children' };
  }

  const system = await deps.loadPrompt();
  const model = await deps.loadModel();

  const userMessage = JSON.stringify({
    area_coarse: areaCoarse,
    stage: primaryStage,
    interests,
    limit: DISCOVERY_LIMIT,
    // The discovery prompt documents season_hint as an optional input used only to
    // avoid out-of-season picks (rule #2: no prompt change). Present ONLY for a
    // season-scoped search run; a standing run omits it entirely.
    ...(searchSeason ? { season_hint: searchSeason } : {}),
  });

  // Trace the single discovery call: a scheduled/on-demand run (userId 'system'),
  // familyId is correlating metadata. Only the coarse area + stage + interests
  // reach the model and the trace; the mask is the rule-#1 backstop.
  return traceAgentRun(
    {
      name: 'discovery',
      userId: 'system',
      tags: ['discovery'],
      metadata: { familyId },
    },
    async (trace) => {
      const startedAt = Date.now();
      const response = await deps.client.messages.create({
        model,
        max_tokens: 4096,
        system,
        tools: [
          {
            name: DISCOVERY_TOOL,
            description: 'Return the structured local activity candidates.',
            input_schema: candidatesJsonSchema,
          },
        ],
        tool_choice: { type: 'tool', name: DISCOVERY_TOOL },
        messages: [{ role: 'user', content: userMessage }],
      });

      const usage = {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      };
      trace.recordGeneration('discovery-llm-call', { model, usage });
      const recordRun = (status: 'completed' | 'failed') =>
        recordAgentRun(database, {
          familyId,
          agentName: 'discovery',
          modelUsed: model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUsd: sonnetCostUsd(usage),
          latencyMs: Date.now() - startedAt,
          status,
          langfuseTraceId: trace.traceId,
        });

      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === DISCOVERY_TOOL,
      );
      if (!toolUse) {
        // Rule #8: a forced-tool call that came back without the tool is a failed run —
        // record it (the model still billed input/output tokens) before surfacing.
        await recordRun('failed');
        throw new Error(`discovery: model returned no ${DISCOVERY_TOOL} tool call`);
      }
      const parsed = candidatesSchema.parse(toolUse.input);

      const candidates = parsed.candidates.slice(0, DISCOVERY_LIMIT);
      if (candidates.length === 0) {
        await recordRun('completed');
        return { status: 'discovered', insertedCount: 0 };
      }

      // Resolve each venue to PUBLIC coords (a YMCA, a library) for the map pin,
      // using the COARSE area only (rule #1). Resolve the coarse-area centre ONCE
      // and bias every venue lookup to it, so a same-named venue in another city
      // doesn't win the pin. Best-effort and bounded by the discovery limit; an
      // online / no-venue activity or a miss stays null (list-only, no pin).
      // geocodeVenue never throws (rule #8 boundary), so one bad lookup can't
      // abort the discovery write.
      const bias = (await deps.geocodeArea(areaCoarse)) ?? undefined;
      const geocoded = await Promise.all(
        candidates.map((c) => deps.geocode(c.title, areaCoarse, bias)),
      );

      await database.transaction(async (tx) => {
        // REPLACE within THIS run type, don't accumulate: soft-retire this family's
        // prior active set of the SAME run type so a re-run swaps in the new one. A
        // soft stamp (not DELETE) keeps endorsed / shared candidates alive for their
        // public /a/:token page (rule #6 audit + the share token both survive); the
        // live feed filters superseded_at IS NULL. Sets ONLY superseded_at.
        //
        // Scoped by run type so the two feeds COEXIST: a search run supersedes only
        // prior SEARCH rows (never the standing weekly feed), and a standing run
        // supersedes only STANDING rows (run_type 'standing' OR legacy null, which
        // the migration backfilled to 'standing') — so neither clobbers the other.
        const runTypeScope = searchSeason
          ? eq(schema.villageCandidates.runType, 'search')
          : or(
              eq(schema.villageCandidates.runType, 'standing'),
              isNull(schema.villageCandidates.runType),
            );
        await tx
          .update(schema.villageCandidates)
          .set({ supersededAt: new Date() })
          .where(
            and(
              eq(schema.villageCandidates.familyId, familyId),
              isNull(schema.villageCandidates.supersededAt),
              runTypeScope,
            ),
          );
        await tx.insert(schema.villageCandidates).values(
          candidates.map((c, i) => {
            const coords = geocoded[i];
            // The VERIFIED Places website wins over the model-supplied url — the
            // latter is often a guess (see coverage_note "not individually
            // confirmed"), so a real venue site resolved from Places is the
            // trustworthy register target. We adopt the model url only when Places
            // has no website AND it survives a cheap sanity check; otherwise null →
            // the register link's coarse-area Google-search fallback (correct by
            // construction). We never invent a url.
            const sourceUrl = coords?.website ?? sanitizeModelUrl(c.sourceUrl);
            return {
              familyId,
              childId: null,
              title: c.title,
              kind: CANDIDATE_KIND,
              cadence: c.cadence ?? null,
              summary: c.description,
              sourceUrl,
              source: SOURCE,
              confidence: c.confidence,
              coverageNote: c.coverageNote,
              eventDate: c.eventDate ?? null,
              seasons: c.seasons ?? null,
              lat: coords?.lat ?? null,
              lng: coords?.lng ?? null,
              venueName: coords?.venueName ?? null,
              venueAddress: coords?.venueAddress ?? null,
              // Which run produced this row, so a search run and the standing feed
              // coexist and each is superseded only by its own kind (see above).
              runType,
              searchSeason,
            };
          }),
        );
        await tx.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'village.discovery.recorded',
          targetTable: 'village_candidates',
          after: { areaCoarse, provider: SOURCE, count: candidates.length },
        });
      });

      await recordRun('completed');

      return { status: 'discovered', insertedCount: candidates.length };
    },
  );
}

/**
 * Production deps: the shared Anthropic client + the worker-sourced prompt/model
 * loaders. The Server Action passes this; tests pass a fake client + loaders so
 * discovery is exercised without a real LLM call (hard rule #8 covers AGENT
 * behaviour via the eval; this unit test asserts orchestration / persistence).
 */
let anthropicClient: Anthropic | undefined;

export function defaultDiscoverDeps(): DiscoverDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return {
    client: anthropicClient,
    loadPrompt: loadDiscoveryPrompt,
    loadModel: defaultLoadModel,
    geocode: (title, areaCoarse, bias) => geocodeVenue(title, areaCoarse, undefined, bias),
    geocodeArea: (areaCoarse) => geocodeArea(areaCoarse),
  };
}
