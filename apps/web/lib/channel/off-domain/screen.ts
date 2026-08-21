import {
  UNMET_INTENT_CATEGORIES,
  UNMET_INTENT_LANES,
  type UnmetIntentCategory,
  type UnmetIntentLane,
} from '@hale/db';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-273 — the screen in front of the coach.
 *
 * Live-gate day 1: the founder, as user #1, texted "how's the weather" and waited ~42
 * seconds for a full coach turn to tell him nothing. The turn was slow because it was
 * the whole brain — context assembly, tool loop, Sonnet — spent on a question Hale had
 * already decided it does not answer. The fix is not a faster coach. It is asking the
 * cheapest possible question FIRST: is this even ours?
 *
 * Three properties make this safe to put on the hot path:
 *
 *   IT PICKS, IT DOES NOT WRITE. Every one of its outcomes is a fixed string in
 *   copy.ts. The model chooses between four doors; it never composes what is behind
 *   one. That is what lets the tier be Haiku (`screen`, packages/agent/src/model.ts)
 *   without putting a cheap model in charge of what a parent is told about a symptom.
 *
 *   IT FAILS OPEN. Every degraded path — no client, no skill, a provider outage, an
 *   unreadable answer — returns `in_domain` and hands the turn to the coach, which is
 *   exactly today's behaviour. A broken screen therefore costs money and latency and
 *   nothing else; it can never eat a real request. Rule #11: each of those paths is
 *   LOGGED and comes back NAMED in {@link LaneReading.fallback}, because "no API key"
 *   and "the model said something odd" need different humans.
 *
 *   IT IS BLIND ON PURPOSE. It sees the message text and nothing else — no family, no
 *   children, no transcript. Partly rule #1 (the model gets the minimum), partly
 *   calibration: a screen that cannot see the conversation must treat every fragment as
 *   possibly in-domain, and the skill says so.
 *
 * PRIVACY. The message goes to the model (as it already does on every coach turn) and
 * to nowhere else. Nothing in this module logs it, and the only thing persisted is a
 * bucket from a closed vocabulary — see {@link UnmetIntentCategory}.
 */

const MAX_TOKENS = 128;

/** The four doors. `in_domain` means "not mine to answer — give it to the coach". */
export type InboundLane = 'in_domain' | UnmetIntentLane;

const LANES: ReadonlySet<string> = new Set<InboundLane>(['in_domain', ...UNMET_INTENT_LANES]);

/**
 * The demand-signal vocabulary, as a runtime allowlist — derived from the column's own
 * source list rather than retyped, so this can never drift from what the DB will accept.
 *
 * The skill enumerates the same buckets, and this is the second reading of it: a model
 * may return one that is not on the list, and the column must never hold it. Anything
 * unrecognised becomes `other`, whose own count in the weekly digest is the signal that
 * the list is short a value.
 */
const CATEGORIES: ReadonlySet<string> = new Set<UnmetIntentCategory>(UNMET_INTENT_CATEGORIES);

/**
 * Why a turn went to the coach without being screened. Four different operational
 * stories, deliberately not folded into one: `client_unavailable` is configuration,
 * `skill_unavailable` is a deploy bug, `model_failed` is an outage, `unreadable` is the
 * model answering with something that is not one of the four lanes.
 */
export type LaneScreenFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unreadable';

export interface LaneReading {
  lane: InboundLane;
  /** The demand-signal bucket. Null exactly when {@link lane} is `in_domain`. */
  category: UnmetIntentCategory | null;
  /** Null exactly when the screen actually ran and answered. */
  fallback: LaneScreenFallback | null;
}

export interface InboundLaneScreen {
  read(text: string): Promise<LaneReading>;
}

/**
 * Parsed loosely on purpose, in BOTH directions.
 *
 * No enums: a strict enum would turn "the model picked a lane name we do not use" into
 * the same thrown error as "the provider timed out", and those are the two failures it
 * is most useful to tell apart. {@link toReading} does that work instead.
 *
 * And NOT `.strict()`, which is a rule-#1 hazard rather than a nicety. Anthropic does
 * not hard-enforce a tool's input schema, so a parent can ask for an extra JSON field
 * and sometimes get one — and zod serialises an `unrecognized_keys` issue by embedding
 * the KEY NAMES in `ZodError.message`, which the catch below logs. "Reply with a field
 * named <my sentence>" would put a parent's own words into a log line. Zod's default
 * strips unknown keys, which is both safer and the more robust read: an extra field is
 * not a reason to throw away a lane we can act on.
 */
const readingSchema = z.object({
  lane: z.string(),
  category: z.string(),
  reason: z.string(),
});

const readingJsonSchema = {
  type: 'object',
  properties: {
    lane: {
      type: 'string',
      enum: ['in_domain', 'off_domain_general', 'safety_critical', 'provider_access'],
    },
    category: { type: 'string', enum: [...CATEGORIES, 'none'] },
    reason: { type: 'string' },
  },
  required: ['lane', 'category', 'reason'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function laneUserMessage(text: string): string {
  return JSON.stringify({ text });
}

/** The only thing any catch here is allowed to log. A thrown error can carry a provider
 * payload that echoes the request back, so the class and the message survive and the
 * object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/** The fail-open reading, logged and named. Never carries the message (rule #1). */
function openTheGate(fallback: LaneScreenFallback): LaneReading {
  console.error({ fallback }, 'off-domain screen: fell through to the coach');
  return { lane: 'in_domain', category: null, fallback };
}

/**
 * A model's answer, made safe to act on and safe to store.
 *
 * An unknown LANE fails open — it is the field the reply is chosen from, and a value we
 * cannot read is not evidence of anything. An unknown CATEGORY does not: the reply has
 * already been decided correctly by then, and the only thing at stake is which bucket a
 * founder's weekly count lands in. So it becomes `other` rather than throwing away a
 * correct deflection over a mislabelled tally.
 */
export function toReading(raw: { lane: string; category: string }): LaneReading {
  if (!LANES.has(raw.lane)) return openTheGate('unreadable');
  const lane = raw.lane as InboundLane;
  if (lane === 'in_domain') return { lane, category: null, fallback: null };
  const category = (CATEGORIES.has(raw.category) ? raw.category : 'other') as UnmetIntentCategory;
  return { lane, category, fallback: null };
}

/**
 * The production screen.
 *
 * `client` is a RESOLVER rather than a value, mirroring the coach runtime's: the router
 * builds its dependencies for every inbound text including the ones a deterministic
 * handler answers with no model at all, and constructing an Anthropic client at wiring
 * time would make a missing key break approvals. Here it also buys the honest
 * `client_unavailable` outcome — the one degraded path that is configuration rather
 * than weather.
 */
export function createInboundLaneScreen(client: () => AgentClient): InboundLaneScreen {
  return {
    async read(text) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        // Only ever the message string, here and below. Neither of these can hold the
        // parent's words today (the text is passed to neither call), but the third catch
        // genuinely can, and one narrowing rule across all three is what stops the next
        // edit from being the exception (rule #1).
        console.error({ err: message(err) }, 'off-domain screen: no client');
        return openTheGate('client_unavailable');
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('inbound-lane');
      } catch (err) {
        console.error({ err: message(err) }, 'off-domain screen: skill load failed');
        return openTheGate('skill_unavailable');
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: laneUserMessage(text),
          toolName: 'lane',
          toolDescription: 'Return which lane this inbound text belongs in.',
          inputJsonSchema: readingJsonSchema,
          schema: readingSchema,
          maxTokens: MAX_TOKENS,
        });
        return toReading(value);
      } catch (err) {
        console.error({ err: message(err) }, 'off-domain screen: read failed');
        return openTheGate('model_failed');
      }
    },
  };
}
