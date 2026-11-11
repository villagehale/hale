import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossParentClashEnabled } from './config';
import {
  CROSS_PARENT_CLASH_TOOL,
  crossParentClashLineInput,
  crossParentClashTextUsable,
} from './cross-parent-clash';
import {
  type ClashPerson,
  type ClashPlan,
  type GroupClash,
  findGroupClashes,
} from './group-conflict';

const NOW = new Date('2026-09-25T18:00:00.000Z');
const AT_3 = new Date('2026-09-25T19:00:00.000Z');
const AT_330 = new Date('2026-09-25T19:30:00.000Z');
const AT_4 = new Date('2026-09-25T20:00:00.000Z');

const barton: ClashPerson = { id: 'barton', name: 'Barton', calendar: true };
const sam: ClashPerson = { id: 'sam', name: 'Sam', calendar: true };

function plan(over: Partial<ClashPlan> & Pick<ClashPlan, 'key' | 'title'>): ClashPlan {
  return {
    start: AT_3,
    end: AT_330,
    holders: [],
    takerId: null,
    claimed: false,
    rows: [],
    ...over,
  };
}

function sameKidTwoParents(): GroupClash {
  const [clash] = findGroupClashes({
    plans: [
      plan({ key: 'a', title: 'Maya recital', holders: ['barton'], end: AT_4 }),
      plan({ key: 'b', title: 'Maya dentist', holders: ['sam'] }),
    ],
    busy: [],
    people: [barton, sam],
    now: NOW,
    kids: ['Maya'],
    uncoverSameKid: true,
  });
  return clash as GroupClash;
}

describe('crossParentClashEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays dark unless the flag is exactly true', () => {
    expect(crossParentClashEnabled()).toBe(false);
    vi.stubEnv('CROSS_PARENT_CLASH_ENABLED', 'on');
    expect(crossParentClashEnabled()).toBe(false);
    vi.stubEnv('CROSS_PARENT_CLASH_ENABLED', 'true');
    expect(crossParentClashEnabled()).toBe(true);
  });
});

describe('crossParentClashLineInput', () => {
  const context = {
    people: [barton, sam],
    kids: ['Maya'],
    timeZone: 'America/Toronto',
    language: 'en' as const,
  };

  it('gives each parent their plan as you and the other as them', () => {
    const clash = sameKidTwoParents();
    expect(crossParentClashLineInput(clash, 'barton', context)).toEqual({
      language: 'en',
      kid: 'Maya',
      you: {
        title: 'Maya recital',
        day: 'Friday, September 25',
        start: '15:00',
        end: '16:00',
      },
      other: {
        title: 'Maya dentist',
        name: 'Sam',
        day: 'Friday, September 25',
        start: '15:00',
        end: '15:30',
      },
    });
    expect(crossParentClashLineInput(clash, 'sam', context)?.you.title).toBe('Maya dentist');
    expect(crossParentClashLineInput(clash, 'sam', context)?.other).toMatchObject({
      title: 'Maya recital',
      name: 'Barton',
    });
  });

  it('is nothing for someone who does not hold one of the two', () => {
    expect(crossParentClashLineInput(sameKidTwoParents(), 'rosa', context)).toBeNull();
  });
});

describe('crossParentClashTextUsable', () => {
  it('refuses empty text and a link, and there is no fallback', () => {
    expect(crossParentClashTextUsable('')).toBeNull();
    expect(crossParentClashTextUsable('  ')).toBeNull();
    expect(crossParentClashTextUsable('https://example.com/pick')).toBeNull();
    expect(crossParentClashTextUsable("Maya can't do both — which one?")).toBe(
      "Maya can't do both — which one?",
    );
  });

  it('asks the model only for the line', () => {
    expect(CROSS_PARENT_CLASH_TOOL.inputSchema.required).toEqual(['text']);
    expect(CROSS_PARENT_CLASH_TOOL.inputSchema.properties).toEqual({ text: { type: 'string' } });
  });
});
