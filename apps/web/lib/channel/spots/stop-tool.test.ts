import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { augmentCoachSkillForStopWatching, stopWatchingTool } from './stop-tool';
import type { ParentLiveWatch } from './store';

/**
 * VIL-337 · `stop_watching`. The model reads "stop watching" in any words; these tests pin
 * which watch it may end and that the verb never guesses between several.
 */

const CTX = { familyId: 'fam-1', actor: 'parent-1' };
const SWIM: ParentLiveWatch = { id: 'w-1', label: 'Tuesday preschool swim', host: 'a.example' };
const SKATE: ParentLiveWatch = { id: 'w-2', label: 'Saturday skating', host: 'a.example' };

function ports(live: ParentLiveWatch[]) {
  const released: string[] = [];
  const asked: Array<{ familyId: string; parentUserId: string }> = [];
  const tool = stopWatchingTool({
    liveWatches: async (scope) => {
      asked.push(scope);
      return live;
    },
    release: async ({ spot }) => {
      released.push(spot.id);
      return true;
    },
  });
  return { tool, released, asked };
}

describe('stop_watching', () => {
  it("ends the one watch the parent has, reading only that parent's watches", async () => {
    const { tool, released, asked } = ports([SWIM]);

    await expect(tool.handler({}, CTX)).resolves.toEqual({ stopped: [SWIM.label] });
    expect(released).toEqual([SWIM.id]);
    expect(asked).toEqual([{ familyId: 'fam-1', parentUserId: 'parent-1' }]);
  });

  it('never guesses between several: it names them and ends nothing', async () => {
    const { tool, released } = ports([SWIM, SKATE]);

    await expect(tool.handler({}, CTX)).rejects.toThrow(
      /"Tuesday preschool swim", "Saturday skating"/,
    );
    expect(released).toEqual([]);
  });

  it('ends exactly the labelled one, whatever its case and spacing', async () => {
    const { tool, released } = ports([SWIM, SKATE]);

    await expect(tool.handler({ label: '  saturday   SKATING ' }, CTX)).resolves.toEqual({
      stopped: [SKATE.label],
    });
    expect(released).toEqual([SKATE.id]);
  });

  it('ends every one on all: true', async () => {
    const { tool, released } = ports([SWIM, SKATE]);

    await tool.handler({ all: true }, CTX);
    expect(released).toEqual([SWIM.id, SKATE.id]);
  });

  it('says there is nothing to stop when nothing is watched', async () => {
    const { tool, released } = ports([]);

    await expect(tool.handler({}, CTX)).rejects.toThrow(/nothing to stop/);
    expect(released).toEqual([]);
  });
});

describe('augmentCoachSkillForStopWatching', () => {
  const skill = { meta: { name: 'coach-channel-sms', tools: ['watch_for_opening'] } } as Skill;

  it('lists the verb only for a parent with a live watch, so the skill bytes stay put otherwise', () => {
    expect(augmentCoachSkillForStopWatching(skill, false)).toBe(skill);
    expect(augmentCoachSkillForStopWatching(skill, true).meta.tools).toEqual([
      'watch_for_opening',
      'stop_watching',
    ]);
  });
});
