import { type GuardDeps, invokeTool } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityFindResult, ActivityFinder } from '~/lib/channel/activity/lane';
import { findActivitiesTool } from '~/lib/channel/activity/tools';
import { VOICE_LOOKUP_BUDGET_MS, withVoiceLookupBudget } from './voice-lookup';

/**
 * VIL-313 · THE ONE BOUNDED LOOK A CALL GETS.
 *
 * Founder call CA170c1fb0: the parent asked, out loud, for Hale to search. The answer was
 * "nothing verified in my list" — a read of a table the call already knew was empty,
 * because relay-deps.ts passed `activity: null` and no verb existed that could reach the
 * web. This is the verb, with the only thing a call adds to it: a wall.
 *
 * WHAT IS REAL HERE: the wall, `find_activities`, its de-identification, and the guarded
 * invoker. FAKED: the web (a scripted finder) and the clock. What the model SAYS about
 * each outcome is the skill's job and the eval's (rule #8); what is pinned here is that
 * the three outcomes reach it as three distinguishable things.
 */

const PICKS: ActivityFindResult = {
  found: true,
  picks: [
    {
      name: 'Parent & Tot Gymnastics',
      ageFit: '18 months - 3 years',
      when: 'Saturdays 9:15am, fall session from Sept 13',
      price: '$142 for 12 weeks',
      sourceName: 'Halton Hills Gymnastics Centre',
      source: 'web',
    },
  ],
};

const QUERY = { subject: 'toddler gymnastics', window: null, town: 'Halton Hills', stage: null };

/**
 * A clock the test drives: `wait` resolves only when the test closes the wall. `fired`
 * latches, because the tool does its reads and its de-identification before it ever
 * reaches the finder — so a `fire()` issued from the test body legitimately lands before
 * the wall has been armed, and a clock that dropped it would hang rather than fail.
 */
function heldClock() {
  let release: (() => void) | null = null;
  let fired = false;
  return {
    wait: (_ms: number) =>
      new Promise<void>((resolve) => {
        if (fired) return resolve();
        release = resolve;
      }),
    /** Close the wall. */
    fire: () => {
      fired = true;
      release?.();
    },
  };
}

const silentPorts = (wait: (ms: number) => Promise<void>) => ({
  log: { error: vi.fn() },
  wait,
});

describe('withVoiceLookupBudget', () => {
  it('hands back the finder‘s own answer when the search beats the wall', async () => {
    const clock = heldClock();
    const finder: ActivityFinder = { find: async () => PICKS };
    const ports = silentPorts(clock.wait);

    expect(await withVoiceLookupBudget(finder, ports).find(QUERY)).toEqual(PICKS);
    // Nothing was cut off, so nothing is reported as cut off.
    expect(ports.log.error).not.toHaveBeenCalled();
  });

  it('answers over_budget — NAMED, never an empty result — when the wall closes first', async () => {
    const clock = heldClock();
    // A search that never comes back: the shape a 30-second research turn has from
    // inside a six-second wall.
    const finder: ActivityFinder = { find: () => new Promise<ActivityFindResult>(() => {}) };
    const ports = silentPorts(clock.wait);

    const lookup = withVoiceLookupBudget(finder, ports).find(QUERY);
    clock.fire();

    expect(await lookup).toEqual({ found: false, reason: 'over_budget' });
    // A budget nobody can tell is firing is a budget nobody can size (rule #11).
    expect(ports.log.error).toHaveBeenCalledTimes(1);
  });

  it('does not let an abandoned search reject into an unhandled rejection', async () => {
    const clock = heldClock();
    const abandoned: { reject: ((err: Error) => void) | null } = { reject: null };
    const finder: ActivityFinder = {
      find: () =>
        new Promise<ActivityFindResult>((_resolve, r) => {
          abandoned.reject = r;
        }),
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const lookup = withVoiceLookupBudget(finder, silentPorts(clock.wait)).find(QUERY);
    clock.fire();
    expect(await lookup).toEqual({ found: false, reason: 'over_budget' });

    // The search the caller stopped waiting on dies afterwards. On this runtime an
    // unhandled rejection takes the instance down — under a live call, on every other
    // socket it is serving.
    abandoned.reject?.(new Error('connection terminated'));
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps every reason the finder itself gives — a wall does not flatten a failure', async () => {
    const clock = heldClock();
    for (const reason of ['client_unavailable', 'skill_unavailable', 'no_picks'] as const) {
      const finder: ActivityFinder = { find: async () => ({ found: false, reason }) };
      expect(await withVoiceLookupBudget(finder, silentPorts(clock.wait)).find(QUERY)).toEqual({
        found: false,
        reason,
      });
    }
  });

  it('is six seconds — the ceiling on how long a caller holds a silent line', () => {
    expect(VOICE_LOOKUP_BUDGET_MS).toBe(6_000);
  });
});

describe('find_activities, reached from a call', () => {
  const reader = {
    municipality: async () => 'halton_hills' as const,
    stage: async () => 'toddler' as const,
    householdNames: async () => ['Noah'],
  };
  const ctx = { familyId: 'fam-1', actor: 'parent-1' };
  const guardDeps = (): GuardDeps => ({
    async writeAudit() {},
    async checkChildContentAccess() {
      return { ok: true, reason: 'ok' };
    },
  });

  async function callTool(finder: ActivityFinder, onPromise = vi.fn()) {
    const clock = heldClock();
    const tool = findActivitiesTool({
      reader,
      finder: withVoiceLookupBudget(finder, silentPorts(clock.wait)),
      onPromise,
    });
    const result = invokeTool(tool, { subject: 'toddler gymnastics' }, ctx, guardDeps());
    clock.fire();
    return { result: await result, onPromise };
  }

  /**
   * The over-budget answer reaches the MODEL as its own reason. That is the whole
   * argument for the enum member: `{found: false}` alone reads as "there is nothing on",
   * which would stop a parent looking for something that is there.
   */
  it('gives the model over_budget rather than an empty answer when the wall closed', async () => {
    const { result } = await callTool({ find: () => new Promise(() => {}) });

    expect(result).toEqual({ found: false, reason: 'over_budget' });
  });

  it('gives the model the fact when the search was in time', async () => {
    const { result } = await callTool({ find: async () => PICKS });

    expect(result).toEqual({ found: true, picks: PICKS.picks });
  });

  /**
   * Two failures that are NOT the same thing, and the tool keeps them apart. `no_picks`
   * is an answer ("there's nothing on"); `client_unavailable` is not ("I couldn't look").
   */
  it.each(['no_picks', 'client_unavailable', 'ground_failed'] as const)(
    'names %s rather than folding it into a silent skip',
    async (reason) => {
      const { result } = await callTool({ find: async () => ({ found: false, reason }) });

      expect(result).toEqual({ found: false, reason });
    },
  );

  /**
   * Phase 0 still runs on a call. The subject crosses the border to a search engine, so
   * a subject naming a member of this household is refused with a sentence the model
   * answers by calling again — never searched (rule #1).
   */
  it('refuses to search a subject that names somebody in the household', async () => {
    const searched = vi.fn(async () => PICKS);
    const tool = findActivitiesTool({
      reader,
      finder: withVoiceLookupBudget({ find: searched }, silentPorts(async () => {})),
      onPromise: vi.fn(),
    });

    await expect(
      invokeTool(tool, { subject: 'gymnastics for Noah' }, ctx, guardDeps()),
    ).rejects.toThrow();
    expect(searched).not.toHaveBeenCalled();
    // The positive control for the line above: the SAME tool searches the moment the
    // subject names nobody, so the refusal is the gate firing rather than a finder that
    // is never reached.
    await invokeTool(tool, { subject: 'toddler gymnastics' }, ctx, guardDeps());
    expect(searched).toHaveBeenCalledTimes(1);
  });
});
