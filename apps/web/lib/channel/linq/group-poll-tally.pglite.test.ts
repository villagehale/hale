import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type GroupPoll,
  type GroupPollReader,
  type GroupPollReading,
  type GroupPollVoter,
  pollReadingFromAnswer,
  pollTallyUserMessage,
  readGroupPollTally,
  tallyPoll,
} from './group-poll-tally';

// What the model reads is the eval's job (run-group-poll-tally-eval.mjs). The reader here
// is a fixed reading; these tests cover only what code owns: keys, mapping, counting,
// one ballot per family, and that a failed read yields no tally.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(name: string): Promise<string> {
  const [f] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return f?.id as string;
}

const POLL = (perFamily: boolean): GroupPoll => ({
  question: 'Which day for the park?',
  perFamily,
  options: [
    { optionId: 'opt-sat', text: 'Saturday' },
    { optionId: 'opt-sun', text: 'Sunday' },
  ],
});

const fixed = (r: GroupPollReading | null): GroupPollReader & { calls: number } => {
  const reader = {
    calls: 0,
    async read() {
      reader.calls += 1;
      return r;
    },
  };
  return reader;
};

describe('group poll tally (VIL-458 slice 1)', () => {
  it('sends the model only opaque keys, never ids', async () => {
    const lee = await seedFamily('Lee');
    const voters: GroupPollVoter[] = [{ voterId: 'u-ana', familyId: lee, firstName: 'Ana' }];
    const msg = pollTallyUserMessage({
      poll: POLL(true),
      voters,
      answers: [
        { kind: 'vote', voterId: 'u-ana', optionId: 'opt-sat', removed: false },
        { kind: 'text', voterId: 'u-ana', text: 'actually sunday' },
      ],
    });
    expect(msg).not.toContain(lee);
    expect(msg).not.toContain('u-ana');
    expect(msg).not.toContain('opt-sat');
    const parsed = JSON.parse(msg);
    expect(parsed.answers[0]).toEqual({ from: 'v1', nativeVote: 'o1', removed: false });
    expect(parsed.voters[0]).toEqual({ key: 'v1', family: 'f1', name: 'Ana' });
  });

  it('rejects a missing, doubled or invented key', () => {
    const input = {
      poll: POLL(false),
      voters: [
        { voterId: 'a', familyId: 'f', firstName: 'A' },
        { voterId: 'b', familyId: 'f', firstName: 'B' },
      ],
    };
    expect(pollReadingFromAnswer(input, { voters: [{ key: 'v1', choice: 'o1' }] })).toBeNull();
    expect(
      pollReadingFromAnswer(input, {
        voters: [
          { key: 'v1', choice: 'o1' },
          { key: 'v1', choice: 'o2' },
        ],
      }),
    ).toBeNull();
    expect(
      pollReadingFromAnswer(input, {
        voters: [
          { key: 'v1', choice: 'o9' },
          { key: 'v2', choice: null },
        ],
      }),
    ).toBeNull();
    const ok = pollReadingFromAnswer(input, {
      voters: [
        { key: 'v1', choice: 'o2' },
        { key: 'v2', choice: null },
      ],
    });
    expect(ok && [...ok]).toEqual([
      ['a', 'opt-sun'],
      ['b', null],
    ]);
  });

  it('per family: one ballot per family, silent member does not block, split is not counted', () => {
    const voters: GroupPollVoter[] = [
      { voterId: 'ana', familyId: 'lee', firstName: 'Ana' },
      { voterId: 'min', familyId: 'lee', firstName: 'Min' },
      { voterId: 'bart', familyId: 'dong', firstName: 'Barton' },
      { voterId: 'wei', familyId: 'dong', firstName: 'Wei' },
      { voterId: 'julie', familyId: 'tremblay', firstName: 'Julie' },
    ];
    const reading: GroupPollReading = new Map([
      ['ana', 'opt-sat'],
      ['min', 'opt-sat'],
      ['bart', 'opt-sat'],
      ['wei', 'opt-sun'],
      ['julie', null],
    ]);
    const t = tallyPoll({ poll: POLL(true), voters }, reading);
    expect(t.counts.get('opt-sat')).toBe(1);
    expect(t.counts.get('opt-sun')).toBe(0);
    expect(t.splitFamilies).toEqual(['dong']);
    expect(t.waitingOn.sort()).toEqual(['dong', 'tremblay']);
    expect(t.everyoneAnswered).toBe(false);

    reading.set('wei', null);
    reading.set('julie', 'opt-sun');
    const t2 = tallyPoll({ poll: POLL(true), voters }, reading);
    expect([t2.counts.get('opt-sat'), t2.counts.get('opt-sun')]).toEqual([2, 1]);
    expect(t2.everyoneAnswered).toBe(true);
  });

  it('parent answers for household; a member who later differs makes the family pending', () => {
    const voters: GroupPollVoter[] = [
      { voterId: 'ana', familyId: 'lee', firstName: 'Ana' },
      { voterId: 'min', familyId: 'lee', firstName: 'Min' },
      { voterId: 'julie', familyId: 'tremblay', firstName: 'Julie' },
    ];
    // Model read of "Saturday for us" from Ana: every Lee voter set to Saturday.
    const reading: GroupPollReading = new Map([
      ['ana', 'opt-sat'],
      ['min', 'opt-sat'],
      ['julie', 'opt-sun'],
    ]);
    const t = tallyPoll({ poll: POLL(true), voters }, reading);
    expect([t.counts.get('opt-sat'), t.counts.get('opt-sun')]).toEqual([1, 1]);
    expect(t.everyoneAnswered).toBe(true);
    // Min later picks Sunday: Lee is split, back to pending, not counted.
    reading.set('min', 'opt-sun');
    const t2 = tallyPoll({ poll: POLL(true), voters }, reading);
    expect([t2.counts.get('opt-sat'), t2.counts.get('opt-sun')]).toEqual([0, 1]);
    expect(t2.splitFamilies).toEqual(['lee']);
    expect(t2.waitingOn).toEqual(['lee']);
    expect(t2.everyoneAnswered).toBe(false);
    // They agree again: counted once.
    reading.set('ana', 'opt-sun');
    const t3 = tallyPoll({ poll: POLL(true), voters }, reading);
    expect(t3.counts.get('opt-sun')).toBe(2);
    expect(t3.everyoneAnswered).toBe(true);
  });

  it('per person: each person is one ballot', () => {
    const voters: GroupPollVoter[] = [
      { voterId: 'ana', familyId: 'lee', firstName: 'Ana' },
      { voterId: 'min', familyId: 'lee', firstName: 'Min' },
    ];
    const t = tallyPoll(
      { poll: POLL(false), voters },
      new Map([
        ['ana', 'opt-sat'],
        ['min', 'opt-sat'],
      ]),
    );
    expect(t.counts.get('opt-sat')).toBe(2);
    expect(t.everyoneAnswered).toBe(true);
  });

  it('a failed read is no tally', async () => {
    const lee = await seedFamily('Lee');
    const reader = fixed(null);
    const out = await readGroupPollTally(db.database, reader, {
      poll: POLL(true),
      voters: [{ voterId: 'ana', familyId: lee, firstName: 'Ana' }],
      answers: [{ kind: 'text', voterId: 'ana', text: 'sat!' }],
    });
    expect(out).toBeNull();
    expect(reader.calls).toBe(1);
  });

  it('drops voters whose family is gone, and their answers, before the read', async () => {
    const lee = await seedFamily('Lee');
    const gone = await seedFamily('Gone');
    await db.database.delete(schema.families).where(eq(schema.families.id, gone));
    let seen: unknown;
    const reader: GroupPollReader = {
      async read(input) {
        seen = input;
        return new Map([['ana', 'opt-sun']]);
      },
    };
    const out = await readGroupPollTally(db.database, reader, {
      poll: POLL(true),
      voters: [
        { voterId: 'ana', familyId: lee, firstName: 'Ana' },
        { voterId: 'x', familyId: gone, firstName: 'X' },
      ],
      answers: [
        { kind: 'text', voterId: 'x', text: 'saturday' },
        { kind: 'text', voterId: 'ana', text: 'dimanche' },
      ],
    });
    expect((seen as { voters: unknown[]; answers: unknown[] }).voters).toHaveLength(1);
    expect((seen as { voters: unknown[]; answers: unknown[] }).answers).toHaveLength(1);
    expect(out?.tally.counts.get('opt-sun')).toBe(1);
    expect(out?.tally.everyoneAnswered).toBe(true);
  });

  it('no live voters: no read, no tally', async () => {
    const reader = fixed(new Map());
    const out = await readGroupPollTally(db.database, reader, {
      poll: POLL(true),
      voters: [],
      answers: [],
    });
    expect(out).toBeNull();
    expect(reader.calls).toBe(0);
  });
});
