import { type Database, schema } from '@hale/db';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { FamilySendKey } from '~/lib/channel/family-send-key';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';
import type { ContentClass } from '~/lib/channel/role-scope';
import { proactiveCadence } from './flag';

/**
 * VIL-226 · the hand-off from a sweep to the family's queue.
 *
 * `off` writes nothing and the sweep sends, exactly as before. `shadow` writes the
 * candidate and the sweep still sends. `live` writes the candidate and the sweep does
 * not send: the hourly decider does. An `immediate` item — a parent-requested or
 * time-critical send — never queues.
 *
 * When live, a store failure throws. A candidate the decider cannot see must not turn into
 * a text nobody decided, and it must not vanish quietly either. In shadow the sweep is
 * still the one deciding and sending, so a store failure there is named
 * (`send_shadow_unqueued`), logged by its class, and the sweep sends as it would have
 * unset: lighting shadow never costs a parent a text.
 */

export type CadenceLane = 'immediate' | 'candidate';

/** The longest class name or code a log line carries. An infra bound on a log field. */
export const ERROR_TOKEN_CHARS = 64;
const ERROR_TOKEN = /^[a-z0-9_.-]+$/i;

/** A class name or a code as one short plain token, or `other`: nothing bounds either. */
function errorToken(part: string): string {
  return part.length <= ERROR_TOKEN_CHARS && ERROR_TOKEN.test(part) ? part : 'other';
}

/**
 * What a log may say about a failed candidate write or review: the error's class and its
 * code. Never the error itself: Postgres reports a refused row in the detail ("Failing
 * row contains ..."), and a candidate row carries the composed, child-named text.
 */
export function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  const code = (err as { code?: unknown }).code;
  const name = errorToken(err.name);
  return typeof code === 'string' ? `${name}:${errorToken(code)}` : name;
}

/** The most frames a failure log carries: the throw site and the calls that led to it. */
export const STACK_FRAMES = 8;
/** One V8 frame: an optional function, then `file:line:column`. */
const STACK_FRAME = /^\s+at (?:((?:async |new )?[\w$.<>[\] ]+) \()?([^\s()]+):(\d+):\d+\)?$/;

/**
 * Where a failure was thrown, as `function file:line` per frame and nothing else, so a
 * bug stays findable from a log that never carries the error. A stack opens with the
 * error's message, which can carry a refused row: everything up to the message's end is
 * cut before the frames are read, and a line that is not a frame is dropped. A stack whose
 * message cannot be found in it (it is empty, or was reassigned after the throw) has no
 * known end to cut at, so it gives no frames.
 */
export function stackFrames(err: unknown): string[] {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return [];
  const messageAt = err.message.length > 0 ? err.stack.indexOf(err.message) : -1;
  if (messageAt < 0) return [];
  return err.stack
    .slice(messageAt + err.message.length)
    .split('\n')
    .map((line) => STACK_FRAME.exec(line))
    .filter((frame) => frame !== null)
    .slice(0, STACK_FRAMES)
    .map(([, fn, file, line]) => `${fn ?? '<anonymous>'} ${file}:${line}`);
}

export type ChannelCategory = (typeof schema.channelMessages.$inferInsert)['category'];

export interface CandidateDraft {
  familyId: string;
  parentUserId: string;
  kind: ProactiveSendKind;
  category: ChannelCategory;
  templateKey: string;
  what: string;
  why: string;
  sourceUrl: string | null;
  worthlessAfter: Date | null;
  parentRequested: boolean;
  /** The ledger dedupe key the sweep would have written. */
  dedupeKey: string;
  /**
   * VIL-612 · sweep after-send the decider must run after a verbatim send.
   * Omitted on kinds that need none.
   */
  payload?: Record<string, unknown> | null;
  /**
   * VIL-776 · the class this line's sweep asked the group-audience rule about. Omitted or
   * null on a line with no class, which the review only ever sends 1:1.
   */
  contentClass?: ContentClass | null;
}

export type HandOff = 'send' | 'queued' | 'send_shadow_unqueued';

/**
 * Queue one evening check-in for the proactive decider, in every cadence mode.
 *
 * The check-in has no fixed text to fall back to, so `off` must not mean "send the
 * old line". The hourly review is what sends. While the flag is off, that review
 * still decides and sends this kind (review.ts); other kinds stay on their own path.
 */
export async function queueCheckInForDecider(
  database: Database,
  draft: CandidateDraft,
): Promise<'queued' | 'duplicate'> {
  const inserted = await database
    .insert(schema.proactiveCandidates)
    .values({ ...draft, payload: draft.payload ?? null, status: 'queued' })
    .onConflictDoNothing({
      target: [schema.proactiveCandidates.familyId, schema.proactiveCandidates.dedupeKey],
    })
    .returning({ id: schema.proactiveCandidates.id });
  return inserted.length === 0 ? 'duplicate' : 'queued';
}

export async function handOffProactive(
  database: Database,
  drafts: readonly CandidateDraft[],
  lane: CadenceLane,
): Promise<HandOff> {
  const mode = proactiveCadence();
  if (mode === 'off' || lane === 'immediate' || drafts.length === 0) return 'send';
  const store = () =>
    database
      .insert(schema.proactiveCandidates)
      .values(
        drafts.map((draft) => ({
          ...draft,
          payload: draft.payload ?? null,
          status: 'queued' as const,
        })),
      )
      .onConflictDoNothing({
        target: [schema.proactiveCandidates.familyId, schema.proactiveCandidates.dedupeKey],
      });
  if (mode === 'live') {
    await store();
    return 'queued';
  }
  const batch = { familyId: drafts[0]?.familyId, kind: drafts[0]?.kind, count: drafts.length };
  try {
    await store();
  } catch (err) {
    console.error(
      { err: errorLabel(err), ...batch },
      'proactive cadence: shadow candidate not stored; the old path still sends',
    );
    return 'send_shadow_unqueued';
  }
  console.info(batch, 'proactive cadence: shadow queued; the old path still sends');
  return 'send';
}

/**
 * True when live cadence already holds this item for the decider, in any status. Lets a
 * sweep skip the compose for an item it handed off on an earlier tick. Always false when
 * not live, so the off and shadow paths read nothing new.
 */
export async function isQueuedForDecider(
  database: Database,
  familyId: string,
  dedupeKey: string,
): Promise<boolean> {
  if (proactiveCadence() !== 'live') return false;
  const [row] = await database
    .select({ id: schema.proactiveCandidates.id })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * VIL-740 · whether this family's candidate under a key from before the family was in it
 * still speaks for this text. Any status does, as it does in {@link isQueuedForDecider}, so
 * a text the decider chose not to send is not offered again. The one exception is an
 * `already_sent` drop: callers read the ledger first, so by here it was another family's
 * row that dropped it, and this family is still owed the text. `IS DISTINCT FROM` because
 * the decider's own drop has a null reason, and `NOT (true AND NULL)` would let it through.
 */
export async function legacyCandidateHolds(
  database: Database,
  familyId: string,
  legacyDedupeKey: string,
): Promise<boolean> {
  const c = schema.proactiveCandidates;
  const [row] = await database
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.familyId, familyId),
        eq(c.dedupeKey, legacyDedupeKey),
        or(ne(c.status, 'dropped'), sql`${c.reason} IS DISTINCT FROM 'already_sent'`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** {@link isQueuedForDecider} for a family send key, in either of its shapes. */
export async function isFamilySendQueued(
  database: Database,
  familyId: string,
  key: FamilySendKey,
): Promise<boolean> {
  if (await isQueuedForDecider(database, familyId, key.dedupeKey)) return true;
  if (key.legacyDedupeKey === null || proactiveCadence() !== 'live') return false;
  return legacyCandidateHolds(database, familyId, key.legacyDedupeKey);
}
