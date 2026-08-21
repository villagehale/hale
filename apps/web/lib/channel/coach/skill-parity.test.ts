import { describe, expect, it } from 'vitest';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { buildChannelCoachTools } from './tools';

/**
 * The live-path parity gate, the same one ask-hale has and for the same reason:
 * `toAnthropicTools` only offers the model the tools NAMED in the skill frontmatter, so
 * a registered-but-unlisted tool is a silent no-op — the model can never call it, and
 * the failure looks like the model choosing not to. Over SMS that reads as Hale
 * refusing to move an event it can plainly see.
 *
 * The reverse direction matters more here than it does in the app: a skill that lists a
 * tool nobody registered makes `runAgent` THROW mid-turn, which the router answers with
 * the honesty template. Both directions are asserted against the real skill file.
 */
describe('coach-channel-sms tools ↔ skill allowlist (live path)', () => {
  const registered = () =>
    buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: searchVillageTool({} as never),
      // Production always wires the web lane and all three collectors (see
      // productionChannelCoach), and every conditional verb — the offer, the referral,
      // the web search, the promise — is only registered when its dependency is present.
      // So parity has to be checked against the set the LIVE path actually builds, not
      // against the smallest one this function can produce.
      activity: { reader: {} as never, finder: {} as never },
      onOffer: () => {},
      onShare: () => {},
      onPromise: () => {},
      now: new Date(),
    }).map((t) => t.name);

  it('offers the model every tool the runtime registers', async () => {
    const skill = await loadCronSkill('coach-channel-sms');
    const allowlist = new Set(skill.meta.tools);

    expect(registered().filter((name) => !allowlist.has(name))).toEqual([]);
  });

  it('lists no tool the runtime does not register', async () => {
    const skill = await loadCronSkill('coach-channel-sms');
    const built = new Set(registered());

    expect(skill.meta.tools.filter((name) => !built.has(name))).toEqual([]);
  });

  it('routes the channel turn through the converse tier, like the app’s Ask', async () => {
    const skill = await loadCronSkill('coach-channel-sms');

    expect(skill.meta.task).toBe('converse');
  });
});
