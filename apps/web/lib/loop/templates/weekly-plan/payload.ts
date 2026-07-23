import type { schema } from '@hale/db';
import type { ChildNameLevel } from '~/lib/loop/prefs';

/**
 * F11 · The Sunday Loop (VIL-218 · B2) — the weekly_plan template payload contract.
 * The Sunday send job assembles this from B1's persisted week_plans artifact + a
 * children lookup, and puts it on the A2 LoopMessage's `payload`; the weekly_plan
 * renderer reads it back (typed via `asWeeklyPlanPayload`). It is the ONLY thing
 * the renderer needs — the renderer never touches the DB.
 *
 * Why children ride here: the artifact bakes each child's first name into item
 * titles (teen-gated at compose time) and carries no raw name/DOB/gender — only
 * childIds. To honor the parent's child_name_level dial (A5) the send job loads the
 * family's children and passes them; the renderer resolves display names through
 * loopChildName. Coarse, non-PII beyond name/DOB stays out of logs (rule #1).
 */

/** The child fields the renderer needs to resolve a name at the parent's level
 * (loopChildName composes the teen age gate on top). */
export interface PlanChild {
  id: string;
  name: string;
  dateOfBirth: string;
  gender: string;
}

export type WeekPlanItem = schema.WeekPlan['items'][number];

export type WeekPlanVoice = schema.WeekPlanVoice;

export interface WeeklyPlanPayload {
  /** Monday of the covered week (the artifact's weekStart key), YYYY-MM-DD. */
  weekStart: string;
  /** The deterministic-fallback narrative sentence (voice.weekFraming when voiced, or
   * an older row's LLM summary), or null. The email uses `voice.weekFraming ?? summary`. */
  summary: string | null;
  /** VIL-229 · the model-composed voice (warm sentences around the facts), or null when
   * the voice stage degraded / an older row predates it. The renderer uses voice fields
   * where present and its deterministic copy where not — nullable BY CONSTRUCTION so a
   * template ALWAYS has a deterministic fallback (rule #8). */
  voice: WeekPlanVoice | null;
  /** The composed items, in artifact order (renderer sorts chronologically). */
  items: WeekPlanItem[];
  /** Every child referenced by the plan's items, for name-level rendering. */
  children: PlanChild[];
  /** The plan surface deep link (push data + the >8-item SMS "Full week" link). */
  deepLink: string;
  /** The CASL unsubscribe link the email body must carry (the send job computes it
   * per parent). Null when unavailable — the send job fails closed before enqueue,
   * so a rendered email always has one. */
  unsubscribeUrl: string | null;
}

/** The render context passed alongside the payload: the parent's resolved
 * child_name_level (from A5 prefs, teen-gate composed per child by loopChildName)
 * and the clock (injected for deterministic tests). */
export interface WeeklyPlanRenderContext {
  nameLevel: ChildNameLevel;
  now: Date;
}

/** Narrow an A2 LoopMessage.payload (Record<string, unknown>) to the weekly_plan
 * shape. Throws on a malformed payload rather than rendering garbage (rule #8: no
 * masking) — the send job is the only producer, so a bad payload is a wiring bug. */
export function asWeeklyPlanPayload(payload: Record<string, unknown>): WeeklyPlanPayload {
  const p = payload as Partial<WeeklyPlanPayload>;
  if (
    typeof p.weekStart !== 'string' ||
    !Array.isArray(p.items) ||
    !Array.isArray(p.children) ||
    typeof p.deepLink !== 'string'
  ) {
    throw new Error('weekly_plan renderer: malformed payload');
  }
  return {
    weekStart: p.weekStart,
    summary: typeof p.summary === 'string' ? p.summary : null,
    voice: narrowWeekVoice(p.voice),
    items: p.items,
    children: p.children,
    deepLink: p.deepLink,
    unsubscribeUrl: typeof p.unsubscribeUrl === 'string' ? p.unsubscribeUrl : null,
  };
}

/** Narrow the payload's JSON-round-tripped `voice` back to a typed WeekPlanVoice, or
 * null. The composer already validated + lint-guarded it before persisting, so this is
 * a light structural check: a malformed value degrades to null (the deterministic plan
 * still renders — rule #8), never throws. */
function narrowWeekVoice(value: unknown): WeekPlanVoice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<WeekPlanVoice>;
  if (
    typeof v.greeting !== 'string' ||
    typeof v.weekFraming !== 'string' ||
    typeof v.signOff !== 'string' ||
    typeof v.itemLines !== 'object' ||
    v.itemLines === null
  ) {
    return null;
  }
  return { greeting: v.greeting, weekFraming: v.weekFraming, itemLines: v.itemLines, signOff: v.signOff };
}
