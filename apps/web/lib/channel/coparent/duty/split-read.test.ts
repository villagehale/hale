import { describe, expect, it } from 'vitest';
import { splitDutyReadFromExtraction } from './split-read';

const PARENTS = [
  { userId: 'ana', name: 'Ana' },
  { userId: 'sam', name: 'Sam' },
] as const;

const EVENTS = [
  { eventKey: 'hockey', role: 'attend' as const, kid: 'Maya', label: 'hockey' },
  { eventKey: 'dance', role: 'attend' as const, kid: 'Leo', label: 'dance' },
] as const;

const INPUT = {
  text: "I'll take Maya, you take Leo",
  speakerUserId: 'ana',
  parents: PARENTS,
  events: EVENTS,
};

describe('splitDutyReadFromExtraction', () => {
  it('writes a split when both kids have a driver', () => {
    const read = splitDutyReadFromExtraction(INPUT, {
      kind: 'split',
      confidence: 0.9,
      assignments: [
        { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.9 },
        {
          eventKey: 'dance',
          kid: 'Leo',
          claim: 'other_parent',
          name: 'Sam',
          confidence: 0.9,
        },
      ],
    });
    expect(read.write).toBe(true);
    expect(read.kind).toBe('split');
    expect(read.assignments).toEqual([
      expect.objectContaining({ eventKey: 'hockey', userId: 'ana', claim: 'self' }),
      expect.objectContaining({ eventKey: 'dance', userId: 'sam', claim: 'other_parent' }),
    ]);
  });

  it('writes both events to the speaker for takes-both and change of mind', () => {
    const both = splitDutyReadFromExtraction(
      { ...INPUT, text: "I'll take both" },
      {
        kind: 'takes_both',
        confidence: 0.9,
        assignments: [
          { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.9 },
          { eventKey: 'dance', kid: 'Leo', claim: 'self', name: null, confidence: 0.9 },
        ],
      },
    );
    expect(both.write).toBe(true);
    expect(both.assignments.every((row) => row.userId === 'ana')).toBe(true);

    const change = splitDutyReadFromExtraction(
      { ...INPUT, text: "actually I'll take both" },
      {
        kind: 'change_of_mind',
        confidence: 0.88,
        assignments: [
          { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.88 },
          { eventKey: 'dance', kid: 'Leo', claim: 'self', name: null, confidence: 0.88 },
        ],
      },
    );
    expect(change.write).toBe(true);
    expect(change.kind).toBe('change_of_mind');
  });

  it('writes nothing when nobody is assigned, confidence is low, or a kid is missing', () => {
    expect(
      splitDutyReadFromExtraction(INPUT, { kind: 'none', confidence: 0.9, assignments: [] }).write,
    ).toBe(false);
    expect(
      splitDutyReadFromExtraction(INPUT, {
        kind: 'split',
        confidence: 0.4,
        assignments: [
          { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.9 },
          { eventKey: 'dance', kid: 'Leo', claim: 'other_parent', name: 'Sam', confidence: 0.9 },
        ],
      }).write,
    ).toBe(false);
    expect(
      splitDutyReadFromExtraction(INPUT, {
        kind: 'split',
        confidence: 0.9,
        assignments: [
          { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.9 },
        ],
      }).write,
    ).toBe(false);
  });
});
