import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';
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
}

export type HandOff = 'send' | 'queued' | 'send_shadow_unqueued';

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
      .values(drafts.map((draft) => ({ ...draft, status: 'queued' as const })))
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
