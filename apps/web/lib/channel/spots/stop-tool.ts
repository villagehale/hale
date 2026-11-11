import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';
import type { ParentLiveWatch } from './store';

/**
 * VIL-337 · `stop_watching` — the parent ends a watch, in any words.
 *
 * The model reads the intent; nothing here matches words. It picks the watch by the
 * label the parent's own watch was stored under, which this verb hands back when there is
 * more than one, so the choice is the model's and the match is an identifier, not a
 * keyword. The release is written in the handler, not at send time: stopping is the safe
 * direction, and a reply that never reaches the parent must not leave them being texted
 * about a class they asked Hale to drop.
 */

export const STOP_WATCHING_TOOL = 'stop_watching';

export interface SpotReleasePorts {
  /** The live watches THIS parent armed (store.ts loadParentLiveWatches). */
  liveWatches: (input: { familyId: string; parentUserId: string }) => Promise<ParentLiveWatch[]>;
  /** Ends one; false when the sweep already had (store.ts releaseWatchByParent). */
  release: (input: {
    familyId: string;
    parentUserId: string;
    spot: ParentLiveWatch;
  }) => Promise<boolean>;
}

function quoted(watches: readonly ParentLiveWatch[]): string {
  return watches.map((watch) => `"${watch.label}"`).join(', ');
}

export function stopWatchingTool(ports: SpotReleasePorts): RegisteredTool {
  return defineTool({
    name: STOP_WATCHING_TOOL,
    description:
      'Stop watching a class for an opening, when the parent says in any words or language that they no longer want Hale to watch it - they got in, changed plans, or just want it stopped. Leave `label` out when they are watching one class. When they are watching several, this tells you the labels: call it again with `label` set to exactly the one they mean, or with `all: true` when they mean every one. After it answers, tell them in your own words that you have stopped watching it. Do not call it for a class they want to keep watching.',
    inputSchema: z.object({
      label: z.string().min(1).max(40).optional(),
      all: z.boolean().optional(),
    }),
    inputExamples: [{}, { label: 'Tuesday preschool swim' }, { all: true }],
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const scope = { familyId: ctx.familyId, parentUserId: ctx.actor };
      const live = await ports.liveWatches(scope);
      if (live.length === 0) {
        throw new Error(
          'Nothing is being watched for this parent right now, so there is nothing to stop. Tell them that plainly.',
        );
      }
      const wanted = input.label?.replace(/\s+/g, ' ').trim().toLowerCase();
      const chosen = input.all
        ? live
        : wanted !== undefined
          ? live.filter((watch) => watch.label.toLowerCase() === wanted)
          : live.length === 1
            ? live
            : [];
      if (chosen.length === 0) {
        throw new Error(
          `This parent has ${live.length} classes being watched: ${quoted(live)}. Call stop_watching again with label set to exactly the one they mean, or with all: true if they mean all of them. If none of these is the class they mean, ask them which one.`,
        );
      }
      const stopped: string[] = [];
      for (const spot of chosen) {
        if (await ports.release({ ...scope, spot })) stopped.push(spot.label);
      }
      return { stopped };
    },
  });
}

/**
 * The coach skill on disk does not name this verb, so its bytes (and the channel eval's
 * cache keys) stay put for every parent with nothing being watched. A parent with a live
 * watch gets the name listed; the runtime always registers the verb.
 */
export function augmentCoachSkillForStopWatching(skill: Skill, hasLiveWatch: boolean): Skill {
  if (!hasLiveWatch || skill.meta.tools.includes(STOP_WATCHING_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, STOP_WATCHING_TOOL] },
  };
}
