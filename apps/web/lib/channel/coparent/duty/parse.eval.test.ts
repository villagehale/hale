import { describe, expect, it } from 'vitest';
import { dutyParseFromExtraction } from './extract';
import {
  DUTY_FIXTURES,
  DUTY_SLOT_ACCURACY_FLOOR,
  type DutyFixture,
  fixtureInput,
} from './fixtures';
import { interpretDutyReply } from './interpret';
import type { DutyParse } from './parse';

function sameSlot(
  got: DutyParse['slots'][number],
  expected: DutyFixture['expect']['slots'][number],
): boolean {
  if (got.role !== expected.role || got.claim !== expected.claim) return false;
  if (expected.userId && got.userId !== expected.userId) return false;
  if (expected.name && got.name?.toLowerCase() !== expected.name.toLowerCase()) return false;
  return true;
}

function score(parsed: DutyParse, row: DutyFixture): { hit: number; total: number } {
  const expected = row.expect.slots;
  const used = new Set<number>();
  let hit = 0;
  let total = expected.length;
  for (const slot of expected) {
    const index = parsed.slots.findIndex(
      (candidate, i) => !used.has(i) && sameSlot(candidate, slot),
    );
    if (index >= 0) {
      used.add(index);
      hit += 1;
    }
  }
  total += parsed.slots.length - used.size;
  const flags =
    parsed.write === row.expect.write &&
    parsed.question === row.expect.question &&
    parsed.askWhichKid === row.expect.askWhichKid;
  if (expected.length === 0) {
    total += 1;
    if (flags) hit += 1;
  } else if (!flags) {
    total += 1;
  }
  return { hit, total };
}

describe('co-parent duty reply eval', () => {
  it('covers me, neither, pickup-not-dropoff, both, maybe, questions, and tapbacks', () => {
    const ids = DUTY_FIXTURES.map((row) => row.id).join(' ');
    expect(ids).toMatch(/me/);
    expect(ids).toMatch(/neither/);
    expect(ids).toMatch(/pickup-not-dropoff/);
    expect(ids).toMatch(/both/);
    expect(ids).toMatch(/maybe/);
    expect(ids).toMatch(/question/);
    expect(ids).toMatch(/tap-/);
  });

  it(`slot accuracy is at least ${DUTY_SLOT_ACCURACY_FLOOR}`, async () => {
    let hit = 0;
    let total = 0;
    const misses: string[] = [];
    for (const row of DUTY_FIXTURES) {
      const input = fixtureInput(row);
      const parsed = await interpretDutyReply(input, async (received) => {
        if (!row.llm) return null;
        return dutyParseFromExtraction(received, {
          question: row.llm.question ?? false,
          confidence: row.llm.confidence,
          slots: row.llm.slots,
        });
      });
      const scored = score(parsed, row);
      hit += scored.hit;
      total += scored.total;
      if (scored.hit !== scored.total) {
        misses.push(
          `${row.id} hit ${scored.hit}/${scored.total} write=${parsed.write} q=${parsed.question} kid=${parsed.askWhichKid} slots=${JSON.stringify(parsed.slots)}`,
        );
      }
    }
    expect(misses, misses.join('\n')).toEqual([]);
    expect(total).toBeGreaterThan(0);
    expect(hit / total).toBeGreaterThanOrEqual(DUTY_SLOT_ACCURACY_FLOOR);
  });

  it('a question and a low-confidence extraction do not write', async () => {
    const question = DUTY_FIXTURES.find((row) => row.id === 'question-who');
    const low = DUTY_FIXTURES.find((row) => row.id === 'nana-later-low');
    if (!question || !low) throw new Error('missing fixture');
    const asked = await interpretDutyReply(fixtureInput(question));
    const unsure = await interpretDutyReply(fixtureInput(low), async (received) => {
      if (!low.llm) return null;
      return dutyParseFromExtraction(received, {
        question: false,
        confidence: low.llm.confidence,
        slots: low.llm.slots,
      });
    });
    expect(asked.write).toBe(false);
    expect(asked.question).toBe(true);
    expect(unsure.write).toBe(false);
    expect(unsure.slots[0]?.confidence).toBeLessThan(0.7);
  });
});
