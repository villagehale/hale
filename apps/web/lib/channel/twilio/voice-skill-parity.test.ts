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
      activity: { reader: {} as never, finder: {} as never },
      onPromise: () => {},
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

  /**
   * VIL-313 reversed this. The call used to pass `activity: null`, so an explicit spoken
   * "can you search for me" was answered out of `search_village` — a read of finds the
   * radar already held — and on founder call CA170c1fb0 that read was empty, so the
   * answer was "nothing verified in my list". A surface whose promise is "I answer"
   * answering a search request by reading a table it knew was empty.
   *
   * The seconds of silence that kept the verbs out are still real; what changed is that
   * they are now BOUNDED (voice-lookup.ts) and the over-budget case has an honest
   * sentence with a ledger row under it, rather than the verb not existing.
   */
  it('carries BOTH web verbs, on both sides of the seam', async () => {
    const skill = await loadCronSkill('voice-turn');

    expect(registered()).toContain('find_activities');
    expect(registered()).toContain('promise_activity_followup');
    expect(skill.meta.tools).toContain('find_activities');
    expect(skill.meta.tools).toContain('promise_activity_followup');
  });

  /**
   * The negative control for the pair above: the same builder still DROPS both the
   * moment either half of the wiring is missing, so "the call can search" is a live
   * wiring fact rather than a tool that is always there (rule #11 — the absent
   * collector removes the VERB).
   */
  it('drops both web verbs when the lane or the collector is missing', async () => {
    const withoutLane = buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: null,
      activity: null,
      onPromise: () => {},
      now: new Date(),
    }).map((tool) => tool.name);
    expect(withoutLane).not.toContain('find_activities');
    expect(withoutLane).not.toContain('promise_activity_followup');

    const withoutCollector = buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: null,
      activity: { reader: {} as never, finder: {} as never },
      now: new Date(),
    }).map((tool) => tool.name);
    expect(withoutCollector).not.toContain('find_activities');
    expect(withoutCollector).not.toContain('promise_activity_followup');
  });

  it('still routes a spoken turn through the speak tier', async () => {
    const skill = await loadCronSkill('voice-turn');

    expect(skill.meta.task).toBe('speak');
  });
});
