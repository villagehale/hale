import Anthropic from '@anthropic-ai/sdk';
import type { FamilyStage } from '@hale/types';
import { loadCoachModel } from '~/lib/coach/model';
import {
  DISCOVERY_LIMIT,
  DISCOVERY_TOOL,
  type DiscoveryAnthropicClient,
  candidatesJsonSchema,
  candidatesSchema,
} from './discover';
import { loadDiscoveryPrompt } from './discovery-prompt';

/**
 * The PRE-AUTH, NO-DATABASE value preview (rule #1). It runs the SAME discovery
 * model call as `discoverForFamily` — same prompt (discovery.md, rule #2), same
 * model loader, same tool contract — but for an ANONYMOUS visitor who has not
 * signed up. The difference is the whole point of this module:
 *
 *   - It takes ONLY coarse, anonymous inputs: a stage (mapped from a friendly
 *     age range, never a date of birth), a coarse area (city / FSA, never a
 *     precise address), and optional interest/intent strings. There is no name,
 *     no familyId, and no precise location — the function signature has no field
 *     to carry them.
 *   - It writes NOTHING. No `Database` is injected, so there is no candidate
 *     insert, no audit_log row, and no agent_runs row keyed to anyone. The
 *     sample is computed and returned; it is never persisted, never cached
 *     server-side keyed to anything identifying.
 *   - It is NOT traced/recorded with a familyId, because there is no family. The
 *     only thing that crosses to the model is {area_coarse, stage, interests} —
 *     identical to the post-auth path's payload, minus all the persistence.
 *
 * This is the structural guarantee behind the "no child PII before account +
 * consent" requirement: a path with no DB handle and no identity input cannot
 * leak a child's identity, because it never has one.
 */

/** One sample activity surfaced on the pre-auth preview. A pure projection of
 * the model's candidate — no ids, no childId, no familyId (there is no family). */
export interface PreviewActivity {
  title: string;
  summary: string;
  /** The model's coverage caveat — what it can and can't stand behind. */
  coverageNote: string;
  /** An absolute http(s) link the model offered, or null. Validated before use. */
  sourceUrl: string | null;
}

export interface PreviewInput {
  /** Mapped from the friendly age-range picker — never a date of birth. */
  stage: FamilyStage;
  /** Coarse area only: a city or FSA / postal prefix. Never a precise address. */
  areaCoarse: string;
  /** Optional interest / intent strings the visitor selected. May be empty. */
  interests: string[];
}

export interface PreviewDeps {
  client: DiscoveryAnthropicClient;
  loadPrompt: () => Promise<string>;
  loadModel: () => Promise<string>;
}

/** Same text caps the public share path applies, so untrusted (model-sourced)
 * strings never render unbounded. */
const TITLE_MAX = 200;
const SUMMARY_MAX = 600;
const COVERAGE_MAX = 300;

/** Keep a sourceUrl only if it is an absolute http(s) URL; else drop it — fails
 * closed on javascript:/data: schemes and relative paths (rule #1). Mirrors the
 * public share path's `safeSourceUrl`. */
function safeSourceUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
}

/**
 * Runs the anonymous preview discovery and returns the sample activities. Makes
 * exactly ONE model call (the spend bound), or zero when there is nothing to ask
 * — `teenager` returns an empty list WITHOUT a model call, because real
 * discovery excludes teens by construction (rule #1: a teenager's stage is never
 * queried), so the honest preview shows the "focused on under-13" message rather
 * than fabricate teen activities.
 *
 * Never throws on the empty boundary; a genuine model failure bubbles up
 * (rule #8: don't mask).
 */
export async function discoverPreview(
  input: PreviewInput,
  deps: PreviewDeps,
): Promise<PreviewActivity[]> {
  if (input.stage === 'teenager') {
    return [];
  }

  const system = await deps.loadPrompt();
  const model = await deps.loadModel();

  const userMessage = JSON.stringify({
    area_coarse: input.areaCoarse,
    stage: input.stage,
    interests: input.interests,
    limit: DISCOVERY_LIMIT,
  });

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

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === DISCOVERY_TOOL,
  );
  if (!toolUse) {
    throw new Error(`preview: model returned no ${DISCOVERY_TOOL} tool call`);
  }
  const parsed = candidatesSchema.parse(toolUse.input);

  return parsed.candidates.slice(0, DISCOVERY_LIMIT).map((c) => ({
    title: c.title.slice(0, TITLE_MAX),
    summary: c.description.slice(0, SUMMARY_MAX),
    coverageNote: c.coverageNote.slice(0, COVERAGE_MAX),
    sourceUrl: safeSourceUrl(c.sourceUrl),
  }));
}

let anthropicClient: Anthropic | undefined;

/**
 * Production deps: the shared Anthropic client + the worker-sourced prompt/model
 * loaders (the same single sources `discoverForFamily` uses). The Route Handler
 * passes this; tests pass a fake client + loaders so the preview is exercised
 * without a real LLM call (rule #8 covers AGENT QUALITY via the eval; this unit
 * test asserts the no-DB orchestration + privacy boundary).
 */
export function defaultPreviewDeps(): PreviewDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return {
    client: anthropicClient,
    loadPrompt: loadDiscoveryPrompt,
    loadModel: loadCoachModel,
  };
}
