import { NextResponse } from 'next/server';
import { z } from 'zod';
import { FAMILY_STAGES, type FamilyStage, parseIntents } from '@hale/types';
import { defaultPreviewDeps, discoverPreview } from '~/lib/village/preview';
import { clientIp, enforceRateLimit } from '~/lib/rate-limit/apply';

// Node runtime: discovery uses the Anthropic SDK + the repo-file prompt loader.
export const runtime = 'nodejs';

/**
 * POST /api/preview — the PRE-AUTH "see what Hale finds for you" sample (rule #1).
 *
 * UNAUTHENTICATED by design: this is the value preview shown BEFORE the signup
 * wall. The privacy contract is that the inputs are coarse and anonymous and that
 * NOTHING is persisted server-side keyed to an identity:
 *   - the body carries ONLY a stage (mapped from a friendly age range, never a
 *     DOB), a coarse area (city / FSA, never a precise address), and optional
 *     interest strings — there is no name, no child id, no family id;
 *   - `discoverPreview` takes no `Database` and writes nothing — no candidate
 *     row, no audit row, no agent_runs row, no cache keyed to anything;
 *   - the model receives only {area_coarse, stage, interests}.
 *
 * It is rate-limited per source IP (the only identifier before sign-in) because
 * it triggers a billable model call on an open endpoint.
 */

const bodySchema = z.object({
  /** Mapped from the age-range picker to a stage on the client — validated here
   * against the canonical stage set so a client can't inject an arbitrary value. */
  stage: z.enum(FAMILY_STAGES as readonly [FamilyStage, ...FamilyStage[]]),
  /** Coarse area only (a city or FSA). Bounded; a precise address can't fit and
   * is never asked for. */
  areaCoarse: z.string().trim().min(1).max(120),
  /** Optional raw interest strings; normalized to known intents server-side. */
  interests: z.array(z.string()).max(16).optional(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Per-IP cap before the billable model call — the spend guard for an open,
  // unauthenticated endpoint.
  const limited = await enforceRateLimit('preview', clientIp(req));
  if (limited) return limited;

  // Normalize the visitor's chips to the known intent vocabulary; an unknown or
  // repeated value can never reach the model.
  const interests = parseIntents(parsed.data.interests ?? []);

  const activities = await discoverPreview(
    {
      stage: parsed.data.stage,
      areaCoarse: parsed.data.areaCoarse,
      interests,
    },
    defaultPreviewDeps(),
  );

  return NextResponse.json({ activities });
}
