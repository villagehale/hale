import { type Database, schema } from '@hale/db';
import { followUp } from './copy';
import type { IntakeCollected, IntakeExtractor } from './extract';
import type { IntakeAck, IntakeAckComposer } from './intake-voice';
import type { IntentReading, ReplyIntentReader } from './intent';
import type { RadarComposer } from './radar';

/**
 * VIL-237 · M2 — the Fakes the intake state machine is tested against. No provider, no
 * database, no model.
 *
 * The extractor and the intent reader are faked for MECHANICS only — routing, ordering,
 * and the guards. Their QUALITY is a separate eval against real cached Claude
 * (apps/worker/evals/run-intake-eval.mjs), because a mocked model can only ever confirm
 * that our own fixture came back (rule #8).
 */

/** A scripted extractor: returns the next queued reading, or the last one forever. */
export class FakeExtractor implements IntakeExtractor {
  readonly calls: Array<{ message: string; alreadyKnown: IntakeCollected }> = [];
  constructor(private readonly queue: IntakeCollected[]) {}

  async extract(input: { message: string; alreadyKnown: IntakeCollected }) {
    this.calls.push(input);
    const next = this.queue.length > 1 ? (this.queue.shift() as IntakeCollected) : this.queue[0];
    if (!next) throw new Error('FakeExtractor: no scripted result');
    return next;
  }
}

/** A scripted intent reader, same queue semantics. */
export class FakeIntentReader implements ReplyIntentReader {
  readonly calls: Array<{ question: string; reply: string }> = [];
  constructor(private readonly queue: IntentReading[]) {}

  async read(input: { question: string; reply: string }) {
    this.calls.push(input);
    const next = this.queue.length > 1 ? (this.queue.shift() as IntentReading) : this.queue[0];
    if (!next) throw new Error('FakeIntentReader: no scripted result');
    return next;
  }
}

/** A radar stand-in with a fixed, obviously-synthetic message. It tells no checkpoint:
 * the marker belongs to a message that really carried one (lib/health/told.ts). */
export const fakeRadar: RadarComposer = {
  async compose() {
    return { message: 'RADAR', itemCount: 0, followUpNeeded: false, checkpointTold: null };
  },
};

/**
 * An acknowledgment composer that always degrades to the template — the DETERMINISTIC
 * outcome, which is what the machine's routing tests want to assert against. The
 * composed path is not faked with a canned sentence anywhere: its quality is the eval's
 * job against real cached Claude (rule #8), and its guards are unit-tested directly in
 * intake-voice.test.ts.
 */
export const fakeAckComposer: IntakeAckComposer = {
  async compose(input): Promise<IntakeAck> {
    return {
      body: followUp(input.summary, input.missing),
      source: 'template',
      fallback: 'voice_unavailable',
    };
  },
};

export interface RecordedWrite {
  op: 'insert' | 'update';
  table: unknown;
  payload: Record<string, unknown>;
}

export interface FakeDb {
  db: Database;
  /** Every insert/update, in call order — the assertion surface for "what was written,
   * and in what order" (consent before the stage flip, etc.). */
  writes: RecordedWrite[];
  /** Rows currently stored, per table. */
  rows(table: unknown): Record<string, unknown>[];
}

/**
 * A tiny in-memory stand-in for a Drizzle handle: inserts land in a per-table store and
 * selects read it back, so a multi-turn conversation actually persists between calls.
 *
 * It does NOT evaluate `where` clauses — it returns the whole table and lets the code
 * under test apply its own post-checks (which the real lookups already do as defense in
 * depth). The one exception is sms_intake_sessions, where "the OPEN session" is filtered
 * here, because that predicate is the machine's whole notion of an active conversation.
 */
export function makeFakeDb(): FakeDb {
  const writes: RecordedWrite[] = [];
  const store = new Map<unknown, Record<string, unknown>[]>();
  let idSeq = 0;

  const nextId = () => {
    idSeq += 1;
    return `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`;
  };

  /** The column DEFAULTS the real schema applies on insert. Only sms_intake_sessions
   * needs them — it is the one table the machine reads its own writes back from, and a
   * missing `follow_up_count` would silently read as undefined instead of 0. */
  const defaultsFor = (table: unknown): Record<string, unknown> =>
    table === schema.smsIntakeSessions
      ? {
          followUpCount: 0,
          clarifyCount: 0,
          sourceCode: null,
          familyId: null,
          userId: null,
          lastProviderId: null,
        }
      : {};

  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    const all = store.get(table) ?? [];
    if (table === schema.smsIntakeSessions) {
      return all.filter((r) => r.closedAt === null || r.closedAt === undefined);
    }
    return all;
  };

  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['where', 'orderBy', 'from', 'onConflictDoNothing', 'onConflictDoUpdate']) {
      chain[method] = () => chain;
    }
    chain.limit = () => Promise.resolve(rows);
    chain.returning = () => Promise.resolve(rows);
    // The real query builder is thenable, so a write with no terminal still resolves.
    // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return chain;
  };

  const handle = {
    select: () => ({ from: (table: unknown) => thenable(rowsFor(table)) }),
    insert: (table: unknown) => {
      const chain = thenable([]);
      chain.values = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(payload) ? payload : [payload];
        const stored = store.get(table) ?? [];
        const inserted: Record<string, unknown>[] = [];
        for (const value of list) {
          writes.push({ op: 'insert', table, payload: value });
          const row = {
            id: nextId(),
            closedAt: null,
            revokedAt: null,
            ...defaultsFor(table),
            ...value,
          };
          stored.push(row);
          inserted.push(row);
        }
        store.set(table, stored);
        return thenable(inserted);
      };
      return chain;
    },
    update: (table: unknown) => {
      const chain = thenable([]);
      chain.set = (payload: Record<string, unknown>) => {
        writes.push({ op: 'update', table, payload });
        for (const row of store.get(table) ?? []) {
          Object.assign(row, payload);
        }
        return thenable(store.get(table) ?? []);
      };
      return chain;
    },
  };

  const db = {
    ...handle,
    transaction: async (cb: (tx: typeof handle) => Promise<unknown>) => cb(handle),
  } as unknown as Database;

  return { db, writes, rows: (table) => store.get(table) ?? [] };
}
