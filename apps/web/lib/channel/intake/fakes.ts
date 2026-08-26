import { type Database, schema } from '@hale/db';
import { Column, Param, SQL, StringChunk, is } from 'drizzle-orm';
import type {
  IdentityAskOutcome,
  IdentityAskRequest,
  IdentityAskVoice,
} from '~/lib/channel/identity/ask-voice';
import type {
  IntroAskRequest,
  IntroVoice,
  IntroVoiceOutcome,
} from '~/lib/village/intros/voice';
import type {
  IntakeAnswerComposer,
  IntakeAnswerInput,
  IntakeAnswerOutcome,
} from './answer';
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

/** A radar stand-in with a fixed, obviously-synthetic message. It tells no checkpoint and
 * promises nothing: both markers belong to a message that really carried one
 * (lib/health/told.ts, lib/commitments/ledger.ts). */
export const fakeRadar: RadarComposer = {
  async compose() {
    return {
      message: 'RADAR',
      itemCount: 0,
      followUpNeeded: false,
      checkpointTold: null,
      firstFindPromised: false,
    };
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

/**
 * An answer composer that always finds nothing to answer — the DETERMINISTIC outcome,
 * which is the script every routing test that predates the escape is asserting against.
 * A fake that composed a canned sentence would make every one of them assert on wording
 * instead; what Hale actually says is the gates' job (answer.test.ts) and the eval's
 * (rule #8).
 */
export const fakeSilentAnswerComposer: IntakeAnswerComposer = {
  async compose(): Promise<IntakeAnswerOutcome> {
    return { status: 'nothing_to_answer' };
  },
};

/**
 * A scripted answer composer, recording what it was HANDED — the assertion surface for
 * rule #1: a test proves the postal code and the session state never reached the model
 * by reading `calls`, not by reading the body.
 */
export class FakeAnswerComposer implements IntakeAnswerComposer {
  readonly calls: IntakeAnswerInput[] = [];
  constructor(private readonly outcome: IntakeAnswerOutcome) {}

  async compose(input: IntakeAnswerInput): Promise<IntakeAnswerOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

/**
 * A scripted identity-ask composer. Its body is deliberately not a sentence — the machine
 * tests here assert MECHANICS (was the ask appended, was the ledger row stamped so the
 * capture can find it, does a deferral still send a whole acknowledgment), and a
 * plausible-looking canned line would invite them to assert on wording instead. What Hale
 * actually says is the gates' job (ask-voice.test.ts) and the eval's (rule #8).
 */
export class FakeIdentityAsk implements IdentityAskVoice {
  readonly calls: IdentityAskRequest[] = [];
  constructor(private readonly outcome: IdentityAskOutcome = { status: 'composed', body: 'ASK' }) {}

  async compose(request: IdentityAskRequest): Promise<IdentityAskOutcome> {
    this.calls.push(request);
    return this.outcome;
  }
}

/**
 * The two intro asks' composer, faked. Records what it was HANDED, which is the assertion
 * surface that matters for rule #1: a test proves the counterpart's real name, area and
 * child never reached the model by reading `calls`, not by reading the body.
 */
export class FakeIntroVoice implements IntroVoice {
  readonly calls: IntroAskRequest[] = [];
  constructor(private readonly outcome?: IntroVoiceOutcome) {}

  async compose(request: IntroAskRequest): Promise<IntroVoiceOutcome> {
    this.calls.push(request);
    return this.outcome ?? { status: 'composed', body: echoIntroAsk(request) };
  }
}

/**
 * What the fake composer "writes": the request, spelled out. Deliberately NOT the copy
 * that used to be fixed — a fake that reproduces the real sentence would let a test pass
 * by asserting the old string is still around.
 *
 * It exists so the sweep's PRIVACY tests keep testing the sweep. Whether the counterpart's
 * name can reach a card is a question about what the sweep HANDS a composer, and echoing
 * the request back is the most direct way to ask it: anything that shows up in the body
 * was passed in, and anything that was not passed in cannot show up.
 */
export function echoIntroAsk(request: IntroAskRequest): string {
  if (request.kind === 'optin') return 'Want introductions to other Hale families nearby?';
  const anchor =
    request.anchorTitle === null
      ? ''
      : ` They're also eyeing ${request.anchorTitle} ${request.anchorDay}.`;
  return `A Hale family near you has a ${request.counterpartWord} around ${request.ownChildPossessive} age.${anchor} Want an intro?`;
}

/**
 * An UPDATE's `where` clause, evaluated against a stored row.
 *
 * SELECT's where is still ignored (every reader post-filters what it gets, and they all
 * do it as defense in depth against exactly that). An UPDATE has no second reader: its
 * predicate IS the decision, and some of those predicates are CLAIMS — the co-parent
 * link's `SET consumed_at = now WHERE consumed_at IS NULL` decides which of two
 * simultaneous redeemers gets the seat. A fake that wrote every row would hand both of
 * them the same one, which is the precise bug a test double must not be able to hide.
 *
 * Only the operators the code under test uses are modelled, and an unrecognised one
 * THROWS: a fake that quietly matched everything it could not read would be back to
 * updating the whole table, silently.
 */
type WhereToken =
  | { kind: 'column'; key: string }
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string };

/** Rows here are keyed by the drizzle PROPERTY name, so a `Column` has to be mapped back
 * to the key it was declared under rather than to its database name. */
function columnKey(table: unknown, column: unknown): string {
  const entry = Object.entries(table as Record<string, unknown>).find(([, v]) => v === column);
  if (!entry) throw new Error('fake where: column does not belong to the table being updated');
  return entry[0];
}

function tokenize(expr: unknown, table: unknown, out: WhereToken[]): WhereToken[] {
  if (is(expr, SQL)) {
    for (const chunk of expr.queryChunks) tokenize(chunk, table, out);
    return out;
  }
  if (is(expr, Column)) {
    out.push({ kind: 'column', key: columnKey(table, expr) });
    return out;
  }
  if (is(expr, Param)) {
    out.push({ kind: 'value', value: expr.value });
    return out;
  }
  if (is(expr, StringChunk)) {
    const text = expr.value.join('').trim();
    if (text !== '') out.push({ kind: 'text', text });
    return out;
  }
  throw new Error('fake where: unsupported SQL fragment');
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/** Split on a boolean operator that is not inside a parenthesised group. */
function splitTopLevel(tokens: WhereToken[], operator: 'and' | 'or'): WhereToken[][] {
  const parts: WhereToken[][] = [];
  let depth = 0;
  let current: WhereToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'text' && token.text === '(') depth += 1;
    if (token.kind === 'text' && token.text === ')') depth -= 1;
    if (depth === 0 && token.kind === 'text' && token.text === operator) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  parts.push(current);
  return parts;
}

/** Whether `tokens` wrap the whole expression in one group, rather than opening and
 * closing several. */
function isWrapped(tokens: WhereToken[]): boolean {
  const first = tokens[0];
  if (!(first?.kind === 'text' && first.text === '(')) return false;
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'text' && token.text === '(') depth += 1;
    if (token.kind === 'text' && token.text === ')') {
      depth -= 1;
      if (depth === 0) return index === tokens.length - 1;
    }
  }
  return false;
}

function evaluate(tokens: WhereToken[], row: Record<string, unknown>): boolean {
  if (isWrapped(tokens)) return evaluate(tokens.slice(1, -1), row);
  for (const operator of ['or', 'and'] as const) {
    const parts = splitTopLevel(tokens, operator);
    if (parts.length > 1) {
      return operator === 'or'
        ? parts.some((part) => evaluate(part, row))
        : parts.every((part) => evaluate(part, row));
    }
  }
  const [left, operator, right] = tokens;
  if (left?.kind !== 'column' || operator?.kind !== 'text') {
    throw new Error('fake where: unsupported predicate shape');
  }
  const value = row[left.key];
  if (operator.text === 'is null') return value === null || value === undefined;
  if (operator.text === 'is not null') return value !== null && value !== undefined;
  if (right?.kind !== 'value') throw new Error(`fake where: unsupported operator ${operator.text}`);
  if (operator.text === '=') return sameValue(value, right.value);
  if (operator.text === '<>') return !sameValue(value, right.value);
  throw new Error(`fake where: unsupported operator ${operator.text}`);
}

function matchesWhere(table: unknown, expr: unknown, row: Record<string, unknown>): boolean {
  return evaluate(tokenize(expr, table, []), row);
}

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

  /**
   * The unique indexes this fake models. Each one is here because it is a CLAIM — the
   * winner of the insert is the request that gets to act — and a fake that let both
   * racers insert would pass a test the deployed code fails.
   *
   *   1. channel_messages(provider_message_id) WHERE direction = 'in' — the inbound
   *      hand-off: the winner is the request that enqueues for C1.
   *   2. sms_intake_sessions(phone_hash) WHERE closed_at IS NULL — one open conversation
   *      per number: the winner is the door (text, or the voice front door) that speaks
   *      first.
   *   3. channel_messages(dedupe_key) WHERE dedupe_key IS NOT NULL — at-most-once per
   *      logical message: the winner is the only attempt that reaches a provider.
   *
   * Faithful in BOTH directions: a conflicting insert that declared
   * `onConflictDoNothing` resolves to no rows, and one that did NOT raises the unique
   * violation real Postgres would. Otherwise a caller could drop the conflict clause
   * and still go green here while 23505-ing in production.
   */
  const conflictingIndex = (
    table: unknown,
    value: Record<string, unknown>,
  ): string | null => {
    const existing = store.get(table) ?? [];
    if (
      table === schema.channelMessages &&
      value.direction === 'in' &&
      typeof value.providerMessageId === 'string' &&
      existing.some(
        (row) => row.direction === 'in' && row.providerMessageId === value.providerMessageId,
      )
    ) {
      return 'channel_messages_inbound_provider_msg_uniq';
    }
    if (
      table === schema.channelMessages &&
      typeof value.dedupeKey === 'string' &&
      existing.some((row) => row.dedupeKey === value.dedupeKey)
    ) {
      return 'channel_messages_dedupe_key_uniq';
    }
    if (
      table === schema.smsIntakeSessions &&
      existing.some(
        (row) =>
          row.phoneHash === value.phoneHash &&
          (row.closedAt === null || row.closedAt === undefined),
      )
    ) {
      return 'sms_intake_sessions_phone_open_idx';
    }
    return null;
  };

  /** A conflicting insert: `onConflictDoNothing` swallows it, any other terminal throws. */
  const conflictChain = (constraint: string) => {
    const violation = () =>
      Promise.reject(
        new Error(`duplicate key value violates unique constraint "${constraint}"`),
      );
    const chain: Record<string, unknown> = {
      onConflictDoNothing: () => thenable([]),
      returning: violation,
      // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        violation().then(res, rej),
    };
    return chain;
  };

  const handle = {
    select: () => ({ from: (table: unknown) => thenable(rowsFor(table)) }),
    insert: (table: unknown) => {
      const chain = thenable([]);
      chain.values = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(payload) ? payload : [payload];
        const constraint = list.map((value) => conflictingIndex(table, value)).find(Boolean);
        if (constraint) {
          return conflictChain(constraint);
        }
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
        let predicate: unknown = null;
        const apply = () => {
          const matched = (store.get(table) ?? []).filter((row) =>
            predicate === null ? true : matchesWhere(table, predicate, row),
          );
          for (const row of matched) {
            Object.assign(row, payload);
          }
          return matched;
        };
        const updated: Record<string, unknown> = {
          where: (expr: unknown) => {
            predicate = expr;
            return updated;
          },
          returning: () => Promise.resolve(apply()),
          // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(apply()).then(res, rej),
        };
        return updated;
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
