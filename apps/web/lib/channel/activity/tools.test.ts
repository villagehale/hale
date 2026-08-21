import { type GuardDeps, invokeTool } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import type { ActivityPromise } from './commitment';
import type { ActivityFinder, ActivityPick } from './lane';
import type { BoundActivityReader } from './reader';
import { findActivitiesTool, promiseActivityFollowUpTool } from './tools';

/**
 * THE TWO VERBS AT THEIR BOUNDARY — what the model may make happen, and what it may not.
 *
 * The lane's own invariants are proven in lane.test.ts. What is proven here is the seam:
 * that the town and the age band come off the DATABASE and never off the model's
 * arguments (rule #1), that a query naming a child is refused with a sentence the model
 * can act on rather than quietly stripped, that the per-turn web spend is bounded, and
 * that a promise is de-identified BEFORE it is stored — because the sweep will hand that
 * stored string to a search a day later with no model in between.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const CHILD = 'child-1';

const PICK: ActivityPick = {
  name: 'Halton Hills Gymnastics',
  ageFit: '18 months - 3 years',
  when: 'Saturdays 9:15am',
  price: null,
  sourceName: 'Halton Hills Gymnastics Centre',
  source: 'web',
};

function guardDeps(): GuardDeps {
  return {
    async writeAudit() {},
    async checkChildContentAccess() {
      return { ok: true, reason: 'ok' };
    },
  };
}

function reader(overrides: Partial<BoundActivityReader> = {}): BoundActivityReader {
  return {
    municipality: async () => 'halton_hills',
    stage: async () => 'toddler',
    householdNames: async () => ['Noah'],
    ...overrides,
  };
}

function fakeFinder(seen: unknown[]): ActivityFinder {
  return {
    async find(query) {
      seen.push(query);
      return { found: true, picks: [PICK] };
    },
  };
}

const call = (tool: ReturnType<typeof findActivitiesTool>, input: unknown) =>
  invokeTool(tool, input, { familyId: FAMILY, actor: PARENT }, guardDeps());

describe('find_activities', () => {
  it('attaches the town and the age band from the record, never from the model', async () => {
    const seen: unknown[] = [];
    const tool = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });

    // The model supplies only the activity and the window. There is no argument on this
    // tool through which it could name a place or an age.
    await call(tool, { subject: 'toddler gymnastics', window: 'this fall' });

    expect(seen[0]).toEqual({
      subject: 'toddler gymnastics',
      window: 'this fall',
      town: 'Halton Hills',
      stage: 'toddler',
    });
  });

  it('refuses a subject naming a child with a sentence the model can act on, and searches nothing', async () => {
    const seen: unknown[] = [];
    const tool = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });

    await expect(call(tool, { subject: 'gymnastics for Noah' })).rejects.toThrow(
      /names somebody in the family/,
    );
    expect(seen).toHaveLength(0);
    // And the refusal never repeats the offending text back — that is the whole reason it
    // was refused (rule #1).
    await expect(call(tool, { subject: 'gymnastics for Noah' })).rejects.not.toThrow(/Noah/);
  });

  it('POSITIVE CONTROL - the same tool answers a subject that names nobody', async () => {
    const seen: unknown[] = [];
    const tool = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });

    const result = (await call(tool, { subject: 'gymnastics' })) as { found: boolean };
    expect(result.found).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('bounds the web spend at two searches per turn, and says so rather than no-opping', async () => {
    const seen: unknown[] = [];
    const tool = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });

    await call(tool, { subject: 'gymnastics' });
    await call(tool, { subject: 'swimming' });
    await expect(call(tool, { subject: 'music class' })).rejects.toThrow(/already searched/);
    expect(seen).toHaveLength(2);
  });

  it('is a fresh budget per tool set - a turn cannot spend the last one’s', async () => {
    const seen: unknown[] = [];
    const first = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });
    await call(first, { subject: 'gymnastics' });
    await call(first, { subject: 'swimming' });

    const second = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });
    await expect(call(second, { subject: 'music class' })).resolves.toMatchObject({ found: true });
  });

  it('carries a named failure through rather than pretending nothing was asked', async () => {
    const tool = findActivitiesTool({
      reader: reader(),
      finder: { async find() { return { found: false, reason: 'no_picks' }; } },
    });

    expect(await call(tool, { subject: 'gymnastics' })).toEqual({
      found: false,
      reason: 'no_picks',
    });
  });

  it('is refused for a teenager by the guarded invoker, before the handler runs', async () => {
    const seen: unknown[] = [];
    const tool = findActivitiesTool({ reader: reader(), finder: fakeFinder(seen) });
    const teenGuard: GuardDeps = {
      async writeAudit() {},
      async checkChildContentAccess(_familyId, _toolName, input) {
        return (input as { childId?: string }).childId === CHILD
          ? { ok: false, reason: 'teen content is redacted (rule #1)' }
          : { ok: true, reason: 'ok' };
      },
    };

    await expect(
      invokeTool(tool, { subject: 'gymnastics', childId: CHILD }, { familyId: FAMILY, actor: PARENT }, teenGuard),
    ).rejects.toThrow(/child_content/);
    expect(seen).toHaveLength(0);

    // POSITIVE CONTROL through the SAME guard: a household-wide search names no child,
    // so it is not gated and the search runs.
    await invokeTool(tool, { subject: 'gymnastics' }, { familyId: FAMILY, actor: PARENT }, teenGuard);
    expect(seen).toHaveLength(1);
  });
});

describe('promise_activity_followup', () => {
  it('de-identifies the subject BEFORE it is stored, because the sweep will search it', async () => {
    const promises: ActivityPromise[] = [];
    const tool = promiseActivityFollowUpTool({
      reader: reader(),
      onPromise: (promise) => promises.push(promise),
    });

    await expect(
      invokeTool(
        tool,
        { subject: 'gymnastics for Noah this fall' },
        { familyId: FAMILY, actor: PARENT },
        guardDeps(),
      ),
    ).rejects.toThrow(/names somebody in the family/);
    expect(promises).toEqual([]);
  });

  it('POSITIVE CONTROL - registers a clean subject, scrubbed, for the sweep to re-run', async () => {
    const promises: ActivityPromise[] = [];
    const tool = promiseActivityFollowUpTool({
      reader: reader(),
      onPromise: (promise) => promises.push(promise),
    });

    await invokeTool(
      tool,
      { subject: 'toddler gymnastics, 18 months, this fall' },
      { familyId: FAMILY, actor: PARENT },
      guardDeps(),
    );

    expect(promises).toHaveLength(1);
    expect(promises[0]?.subject).toContain('toddler gymnastics');
    expect(promises[0]?.subject).not.toContain('18 months');
  });
});
