import { describe, expect, it } from 'vitest';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * The live-path parity gate for the CALL, the same one coach-channel-sms has and for the
 * same reason: `toAnthropicTools` offers the model only the tools NAMED in the skill
 * frontmatter, so a registered-but-unlisted verb is a silent no-op — on a phone that
 * reads as Hale refusing to move an event it can plainly see — and a listed-but-
 * unregistered one makes the turn THROW, which the caller hears as "sorry, I lost that
 * one".
 *
 * It also pins the two DELIBERATE exclusions. `offer_full_plan` and `share_referral_link`
 * are registered by the same builder whenever a collector is passed, and the voice wiring
 * passes neither (relay-deps.ts): the plan's payoff is three texts and the referral's
 * whole content is a URL. Asserting their absence here is what stops "pass the collectors
 * too" from looking like a harmless tidy-up.
 */
describe('voice-turn tools ↔ skill allowlist (live path)', () => {
  /** Byte-for-byte the argument shape relay-deps.ts builds for a spoken turn. */
  const registered = () =>
    buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: searchVillageTool({} as never),
      onDraft: () => {},
      activity: null,
      now: new Date(),
    }).map((tool) => tool.name);

  it('offers the model every verb the call registers', async () => {
    const skill = await loadCronSkill('voice-turn');
    const allowlist = new Set(skill.meta.tools);

    expect(registered().filter((name) => !allowlist.has(name))).toEqual([]);
  });

  it('lists no verb the call does not register', async () => {
    const skill = await loadCronSkill('voice-turn');
    const built = new Set(registered());

    expect(skill.meta.tools.filter((name) => !built.has(name))).toEqual([]);
  });

  it('reaches the same schedule verbs a text does', async () => {
    const skill = await loadCronSkill('voice-turn');

    expect(skill.meta.tools).toEqual(
      expect.arrayContaining([
        'lookup_week',
        'search_village',
        'propose_calendar_move',
        'propose_calendar_cancel',
        'propose_calendar_add',
        'get_framework_guidance',
      ]),
    );
  });

  it('carries neither of the two verbs whose payoff is a text', async () => {
    const skill = await loadCronSkill('voice-turn');

    expect(skill.meta.tools).not.toContain('offer_full_plan');
    expect(skill.meta.tools).not.toContain('share_referral_link');
    // The positive control: the same builder DOES register both the moment a collector
    // is passed, so the absence above is a wiring decision rather than a missing tool.
    const withCollectors = buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: null,
      onOffer: () => {},
      onShare: () => {},
      activity: null,
      now: new Date(),
    }).map((tool) => tool.name);
    expect(withCollectors).toContain('offer_full_plan');
    expect(withCollectors).toContain('share_referral_link');
  });

  it('carries neither web verb: a live call cannot wait on a search', async () => {
    const skill = await loadCronSkill('voice-turn');

    // A `web_search` turn is seconds of silence with a parent holding the line, and the
    // promise verb has nothing to hand back on a call. relay-deps.ts passes
    // `activity: null`, so neither verb is built at all.
    expect(registered()).not.toContain('find_activities');
    expect(registered()).not.toContain('promise_activity_followup');
    expect(skill.meta.tools).not.toContain('find_activities');
    expect(skill.meta.tools).not.toContain('promise_activity_followup');
    // The positive control: the same builder DOES register both the moment the lane is
    // wired, so the absence above is a wiring decision rather than a missing tool.
    const withActivity = buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: null,
      activity: { reader: {} as never, finder: {} as never },
      onPromise: () => {},
      now: new Date(),
    }).map((tool) => tool.name);
    expect(withActivity).toContain('find_activities');
    expect(withActivity).toContain('promise_activity_followup');
  });

  it('still routes a spoken turn through the speak tier', async () => {
    const skill = await loadCronSkill('voice-turn');

    expect(skill.meta.task).toBe('speak');
  });
});
