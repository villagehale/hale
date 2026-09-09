import type { RegisteredTool } from '@hale/agent';
import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { buildRankTools } from '~/lib/village/rank/rank-tools';
import { buildAskHaleTools, searchVillageTool } from './tools';

/**
 * VIL-270 · THE DECLARATION MUST EQUAL THE GUARD'S REACH.
 *
 * `touchesChildContent` decides whether the teen/consent rail runs at all
 * (packages/agent/src/tool.ts). The guard behind it resolves the subject child from a
 * literal `childId` key in the tool input and nothing else — so the flag means exactly
 * one thing: "this input can name a child". tool.ts states the other half of the
 * doctrine for tools that reach a child by some OTHER handle: declare `false` and
 * redact at the source instead.
 *
 * Nothing enforced that ⇔ until now, and both directions are real defects:
 *
 *   · a childId-taking tool declared `false` is a silent guard bypass;
 *   · a declared-`true` tool with no childId key is an UNCHECKABLE declaration — the
 *     guard returns `{ok:true, reason:'no child-specific content requested'}` and the
 *     flag reads as a rail that never ran. That is why "just flip the flag on
 *     propose_calendar_move" was never the fix for VIL-270, and this test is what makes
 *     the non-fix fail rather than look like progress.
 *
 * Every builder here constructs its registry without touching the database — the handles
 * are closed over, not called — so a fake is enough to enumerate the declarations.
 */

/** Never dereferenced: these builders close over the handle, they do not call it. */
const NO_DB = {} as Database;
const NOW = new Date('2026-07-30T12:00:00.000Z');

/**
 * A floor, not a count: a registry that silently stopped registering anything would
 * otherwise pass this file with an empty array. Deliberately well below the 26 entries
 * the five builders register today, so adding or removing one verb is not a test edit.
 */
const MIN_REGISTERED_TOOLS = 15;

function channelTools(): RegisteredTool[] {
  return buildChannelCoachTools({
    familyId: '11111111-1111-4111-8111-111111111111',
    reader: {
      timeZone: async () => 'America/Toronto',
      weekPlanSummary: async () => null,
      eventsInWeek: async () => [],
      resolveEvent: async () => null,
    },
    draftPort: { draft: async () => ({ actionId: 'action-1' }) },
    villageTool: searchVillageTool(NO_DB),
    // Every optional collector wired, because a missing one REMOVES its verb (rule #11)
    // — and a verb that is not registered is a declaration this test never sees.
    activity: {
      reader: {
        municipality: async () => null,
        stage: async () => null,
        householdNames: async () => [],
      },
      finder: { find: async () => ({ outcome: 'unresolvable', reason: 'no_source' }) as never },
    },
    spots: {
      fetchBody: async () => ({ ok: false, reason: 'not_configured' }) as never,
      reader: { householdNames: async () => [] },
      watchConsentGranted: async () => false,
    },
    onDraft: () => {},
    onOffer: () => {},
    onShare: () => {},
    onPromise: () => {},
    onWatch: () => {},
    now: NOW,
  });
}

/** Every tool the app registers anywhere, with the surface it came from for the message. */
function everyRegisteredTool(): Array<{ surface: string; tool: RegisteredTool }> {
  const surfaces: Array<[string, RegisteredTool[]]> = [
    ['buildAskHaleTools', buildAskHaleTools(NO_DB, NOW)],
    ['buildChannelCoachTools', channelTools()],
    ['buildInferenceTools', buildInferenceTools(NO_DB, NOW)],
    ['buildDistillTools', buildDistillTools(NO_DB, NOW)],
    ['buildRankTools', buildRankTools(NO_DB)],
  ];
  return surfaces.flatMap(([surface, tools]) => tools.map((tool) => ({ surface, tool })));
}

/** Whether the tool's own input schema has the key the guard resolves a child from. */
function namesAChild(tool: RegisteredTool): boolean {
  const shape = (tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  return Object.hasOwn(shape, 'childId');
}

describe('touchesChildContent ⇔ the input can name a child', () => {
  it('registers enough tools for this file to be asserting anything', () => {
    expect(everyRegisteredTool().length).toBeGreaterThanOrEqual(MIN_REGISTERED_TOOLS);
  });

  it('every registered tool declares exactly what the guard can reach', () => {
    const mismatched = everyRegisteredTool()
      .filter(({ tool }) => tool.touchesChildContent !== namesAChild(tool))
      .map(({ surface, tool }) => ({
        surface,
        tool: tool.name,
        declared: tool.touchesChildContent,
        takesChildId: namesAChild(tool),
      }));

    // A childId-taking tool declared false is a bypass; a declared-true tool with no
    // childId key is a rail that cannot run. Either way the fix is at the tool, not here.
    expect(mismatched).toEqual([]);
  });

  it('the calendar verbs that reach a child by EVENT HANDLE declare false, and redact at the source', () => {
    // Named explicitly so the doctrine is legible rather than emergent: these three
    // resolve a row, not a child, so their rail is the reader's projection (VIL-270),
    // and the skill's permission to move or cancel a private item by day and time
    // survives. Flipping either flag to true makes the test above red.
    const byName = new Map(everyRegisteredTool().map(({ tool }) => [tool.name, tool]));

    expect(byName.get('propose_calendar_move')?.touchesChildContent).toBe(false);
    expect(byName.get('propose_calendar_cancel')?.touchesChildContent).toBe(false);
    expect(byName.get('lookup_week')?.touchesChildContent).toBe(false);
    // The contrast, in the same registry: the add verb takes a childId, so it IS guarded.
    expect(byName.get('propose_calendar_add')?.touchesChildContent).toBe(true);
  });
});
