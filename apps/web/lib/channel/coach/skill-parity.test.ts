import { describe, expect, it } from 'vitest';
import { findActivitiesTool } from '~/lib/channel/activity/tools';
import { smsUnitsBudget } from '~/lib/channel/sms-segments';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { MAX_REPLY_SEGMENTS } from './reply';
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
      // Production wires the watch verb's three ports too (see productionChannelCoach),
      // and the frontmatter names it — a parity set built without them would report a
      // skill listing a tool nobody registers, which is a mid-turn throw in prod.
      spots: { fetchBody: {} as never, reader: {} as never, watchConsentGranted: {} as never },
      onOffer: () => {},
      onShare: () => {},
      onPromise: () => {},
      onWatch: () => {},
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

  /**
   * ONE reader of "how long may a reply be".
   *
   * There were two, and they disagreed by a factor of nearly two: the skill stated the
   * ceiling in SENTENCES ("four is the ceiling") while `toSmsReply` enforces it in
   * SEGMENTS. On 2026-08-21 a model obeying the skill exactly wrote 548 units of a
   * registration date plus two web-grounded finds against a 306-unit budget, and the
   * whole second paragraph — the part the web search was paid for — was dropped from a
   * message that opened "Two things worth flagging here."
   *
   * So the skill now states the number this function enforces, and this asserts they are
   * the same number. Raising MAX_REPLY_SEGMENTS turns this red until the writer is told.
   */
  it('tells the model the same character ceiling toSmsReply enforces', async () => {
    const skill = await loadCronSkill('coach-channel-sms');
    // GSM-7, because the skill forbids everything else — and smsUnitsBudget answers in
    // the encoding of the body it is handed, so it has to be handed a plain one.
    const budget = smsUnitsBudget('plain ascii', MAX_REPLY_SEGMENTS);

    expect(skill.instructions).toContain(`${budget} characters`);
  });

  /**
   * VIL-365 · a bare activity ask searches the village and does not open on the
   * week. A day or a kind of place also reads the family's own week, and that
   * day comes first, and then what checked out. A bare ask does not open on the
   * week. A full class with no link is asked for as a question. Coaching is one
   * sentence under 200 characters, and the skill never narrates what it has
   * verified. A draft is confirmed in ordinary words, never by telling them to
   * reply YES.
   */
  it('tells the coach to search before asking when a parent wants activities', async () => {
    const skill = await loadCronSkill('coach-channel-sms');
    const find = findActivitiesTool({
      reader: {} as never,
      finder: {} as never,
      onPromise: () => {},
    });

    expect(skill.instructions).toContain('Search in this turn, before any question');
    expect(skill.instructions).toContain('not an unresolved target');
    expect(skill.instructions).toContain('Anything going on Saturday');
    expect(skill.instructions).toContain("who's around this weekend");
    expect(skill.instructions).toContain('The live web only when');
    expect(skill.instructions).toContain('Their own day comes first');
    expect(skill.instructions).toContain('Do not mention the week');
    expect(skill.instructions).toContain('Then what checked out');
    expect(skill.instructions).toContain('as a question they can answer by sending it');
    expect(skill.instructions).not.toContain('One checked find');
    expect(skill.instructions).not.toContain('Do not add a second outing');
    expect(skill.instructions).toContain('exactly one thing that fits');
    expect(skill.instructions).toContain('Do not tell them to reply with a keyword');
    expect(skill.instructions).not.toContain('YES to confirm');
    expect(skill.instructions).not.toContain('Reply YES');
    expect(skill.instructions).toContain('Under 200 characters');
    expect(skill.instructions).not.toContain("what I've got verified");
    expect(skill.instructions).toContain('not them asking that nearby question again');
    expect(skill.instructions).toContain('Do not search instead of asking');
    expect(skill.instructions).toContain('Do not add a question offering to look again');
    expect(find.description).toContain('do not stop to ask which child');
    expect(find.description).toContain('do not call this beside a checked find');
    expect(find.description).toContain('their own week comes first');
    expect(find.description).not.toContain('even when the radar already has a find');
  });

  it('loads the shorten skill as a tool-less rewrite, not a canned reply', async () => {
    const skill = await loadCronSkill('coach-channel-shorten');

    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toEqual([]);
    expect(skill.instructions).toContain('ceiling');
    expect(skill.instructions).toContain('Do not cut a sentence in half');
  });
});
