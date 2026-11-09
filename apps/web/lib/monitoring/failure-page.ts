import { createHash, randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import {
  type SQL,
  type SQLWrapper,
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  like,
  lt,
  sql,
} from 'drizzle-orm';
import { canaryChannel, notCanaryTraffic } from '~/lib/channel/canary/config';
import {
  CRISIS_SITUATIONS,
  CRISIS_WHO,
  type CrisisSituation,
  type CrisisWho,
} from '~/lib/channel/crisis-resources';
import type { ReplyLanguage } from '~/lib/channel/language';
import { readSendRefusal } from '~/lib/channel/outbound-transport';
import type {
  CrisisKind,
  CrisisPageOutcome,
  CrisisPager,
  CrisisUnanswered,
} from '~/lib/channel/voice/said-line';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { type OpsPageOutcome, postOpsSlack } from '~/lib/monitoring/ops-slack';
import {
  INCIDENT_FAILURES,
  type IncidentFailure,
  PROVIDER_INCIDENT_WINDOW_HOURS,
} from '~/lib/monitoring/provider-health';

/**
 * VIL-404 — page Slack #ops when a text turn fails or a new parent's first
 * hello never leaves.
 *
 * Two sms_turn_failed rows (broke_after_answering) on 2026-10-01 were invisible:
 * the ledger had them and nothing was watching it. VIL-315 described the same
 * hole for a first hello that 500'd before any family existed. Twilio is gone;
 * Linq is the only phone door, and the page goes to #ops (postOpsSlack), the
 * same helper the delivery and webhook alarms use. No founder phone.
 *
 * What is alerted, and only that:
 *   - an audit_log row whose action is `sms_turn_failed` (every TurnFailureReason,
 *     including broke_after_answering)
 *   - a first hello whose send threw (the greet, a sitting session that still
 *     has no outbound, or the same-day recovery sweep)
 * The text carries a family id (or `none` when the hello failed before a family
 * existed), an intake session id for that pre-family case, and an error
 * category from a closed vocabulary. It never carries message content, a phone
 * number, or an error message — those can echo a parent's own words.
 *
 * Dedup is a rate_limits claim, not an update of the audit row (audit_log is
 * append-only). One subject, one route, window_start at the epoch, so the
 * unique index is the lock:
 *   - turns: identifier is the sms_turn_failed audit row id. The audit row is
 *     the failure; the claim is only the "already paged" mark (count = 1).
 *   - first hellos: there is no audit row yet (family_id is NOT NULL and the
 *     session has no family). The claim row IS the failure record. identifier
 *     is `<session uuid>:<category>`. count 0 is unalerted, 1 is paged.
 * A claim is taken before the post (count = unix seconds) and set to 1 only
 * after Slack accepts. A refused post puts the claim back, so the next sweep
 * retries. A claim still in progress after two minutes is treated as a crash
 * and released the same way. The sweep looks back seven days, which is long
 * enough to cover the 2026-10-01 rows and short of a family's whole history.
 *
 * The 2026-10-05 credit outage never wrote `sms_turn_failed`. Anthropic answered
 * 400 "credit balance is too low", the turn classifier called that a defect
 * (it is not a 5xx), the apology failed the same way, and the ledger recorded
 * `sms_turn_deferred`. Those rows, a dead-lettered inbound, and a pile of
 * deferrals page through the same claim:
 *   - provider incidents: identifier is `<provider>:<class>` (`anthropic:billing`,
 *     `anthropic:auth` or `anthropic:usage_limit`), windowed like the preflight email so one outage
 *     pages once and the next day's outage pages again. The text carries the
 *     provider, the class, and how many distinct turns were deferred for it.
 *   - dead letters: an inbound that exhausted deferrals. Identifier is
 *     `<family uuid>:<message uuid>`, epoch window, count 0 until Slack accepts.
 *     Internal ids only.
 *   - deferred pile-up: eight or more `sms_turn_deferred` rows in the current
 *     hour, one page per hour. Canary turns are left out of all three.
 *
 * A crisis flagged with no reply sent (VIL-559) pages at once, in the request that
 * gave up on the reply, not on the next sweep. The text carries kind, where, reason
 * and how many writes were tried. The claim row is the record, as with first hellos:
 * most intake crises come before a family exists, and audit_log needs one. Identifier
 * is `<inbound key>:<kind>:<where>:<reason>:<writes>`, the inbound key a hash of the
 * provider's inbound id, so a redelivered inbound pages once. Once a family exists a
 * body-free `crisis_unanswered` audit row is written beside it (rule #6). The claim is
 * recorded under a per-inbound advisory lock, so two deliveries that failed for different
 * reasons still find one row. window_start is the record time, so a paged claim ages out
 * after the lookback; an owed one never does.
 *
 * Every crisis page carries one opaque reference, `ref <rate_limits.id>`, and nothing that
 * names a person. Ops resolves it from that row: the identifier's first field is the first
 * 32 hex characters of sha256(provider message id). That hash matches the inbound's ledger
 * row (channel_messages.provider_message_id), a held text's row in opt_out_held_messages
 * (which gives phone_hash, and from there the channel or session), and, for a family, the
 * `crisis_unanswered` audit row. A crisis read late from a held text pages the same way,
 * `where late_read`. The claim says nothing of what the text said: the language, situation
 * and who it was first read with (situation and who from their closed lists) are kept on
 * the text's held row, so a later tick writes from the same facts without the text being
 * read again, and they go when that row goes, by a read, a release or an erasure. A paged
 * claim whose text is still held is kept past the lookback: the held row still needs it.
 *
 * A crisis reply is marked on `ops:crisis-answered` (identifier: the inbound key alone):
 * count 0 as it leaves, count 1 once the transport accepted it. Only a sent mark counts
 * as answered, and the opt-out recovery pass releases a held copy of that text with no
 * second reply. A leaving mark holds the copy back for its lease, then the text is
 * answered late: a send that failed, timed out or died is never taken for a reply.
 *
 * VIL-602 · every other path that pages #ops goes through {@link pageOps}: a body-free
 * URGENT log, then one claim per site per hour on `ops:page`, then the post. This module
 * is the only place that writes an URGENT or page-#ops log line (ops-page-claims.test.ts).
 *
 * PostHog error tracking is not fed from here. The server has no PostHog
 * client: browser `posthog-js` can `captureException`, and server capture is a
 * raw POST of named product events with no `posthog-node` client
 * (server-capture.ts). A deferral is already counted as `agent_turn_failed`.
 */

/** Same data value wiring.ts writes. A test pins the two spellings together. */
export const TURN_FAILED_AUDIT_ACTION = 'sms_turn_failed';

/** Same data value wiring.ts writes for a deferred turn. Pinned by the same test. */
export const TURN_DEFERRED_AUDIT_ACTION = 'sms_turn_deferred';

export const TURN_FAILURE_PAGE_ROUTE = 'ops:turn-failed';
export const FIRST_HELLO_PAGE_ROUTE = 'ops:first-hello';

/** One Slack page per provider + class per incident window. */
export const PROVIDER_INCIDENT_PAGE_ROUTE = 'ops:provider-incident';

/** One Slack page per dead-lettered inbound turn. */
export const DEAD_LETTER_PAGE_ROUTE = 'ops:turn-dead';

/** One Slack page per hour while deferrals are piled up. */
export const DEFERRED_PILEUP_PAGE_ROUTE = 'ops:deferred-pileup';

/** One Slack page per inbound crisis that got no reply, sent at once. */
export const CRISIS_UNANSWERED_PAGE_ROUTE = 'ops:crisis-unanswered';

/** The reply to an inbound's crisis is leaving or left: one row per inbound key. */
export const CRISIS_ANSWERED_ROUTE = 'ops:crisis-answered';

/** The audit row for a crisis that got no reply, once the parent has a family. */
export const CRISIS_UNANSWERED_AUDIT_ACTION = 'crisis_unanswered';

/**
 * VIL-553 · numbers held for an unread opt-out read. Hourly while a hold is under an
 * hour old; once a UTC day while older holds stand.
 */
export const OPT_OUT_HOLD_PAGE_ROUTE = 'ops:opt-out-held';
/**
 * The old count of held texts read late as a crisis. Nothing writes it since VIL-602 (a
 * late crisis is answered, or paged as a crisis); rows already written age out in a day.
 */
export const OPT_OUT_LATE_CRISIS_ROUTE = 'ops:opt-out-crisis-read';

/** VIL-602 · one page per site per hour, for every path that pages #ops outside a sweep. */
export const OPS_PAGE_ROUTE = 'ops:page';

/**
 * Every site that pages through {@link pageOps}, and each fact it may carry with that fact's
 * closed list of values. A key or value off its site's list never travels, however much it
 * looks like a code (a short name or a postal code does): it is counted as `redacted`. The
 * lists repeat the callers' own unions, and the callers' types pin them: a value added to a
 * union and not here fails typecheck at the call.
 */
export const OPS_PAGE_VOCABULARY = {
  group_plan_unwritten: { change: ['added', 'moved', 'cancelled'] },
  group_conflict_unwritten: { stage: ['skill_load', 'after_retry'] },
  spoken_line_unwritten: { stage: ['skill_load', 'after_retry'] },
  shared_group_unwritten: {
    kind: ['intro', 'who_confirmed', 'answer', 'member_stop', 'family_left', 'family_ask'],
    fallback: ['voice_unavailable', 'skill_unavailable', 'model_failed', 'unusable', 'declined'],
  },
  intake_health_unwritten: {
    basis: [
      'ontario',
      'province_unverified',
      'canada_province_unknown',
      'united_states',
      'region_unknown',
    ],
    reason: ['write_failed', 'writer_absent'],
  },
  opt_out_hold_unwritten: {},
  opt_out_unread: {},
} as const satisfies Record<string, Readonly<Record<string, readonly string[]>>>;

type OpsPageVocabulary = typeof OPS_PAGE_VOCABULARY;

/** A closed list, so the claim key is too. */
export type OpsPageSite = keyof OpsPageVocabulary;

type OpsPageFacts<S extends OpsPageSite> = {
  readonly [K in keyof OpsPageVocabulary[S]]: OpsPageVocabulary[S][K] extends readonly (infer V)[]
    ? V
    : never;
};

/** A page's facts, from its site's vocabulary: never a body, phone or name. */
export type OpsPage = { [S in OpsPageSite]: { site: S; facts: OpsPageFacts<S> } }[OpsPageSite];

/** Same vocabulary as CrisisPageOutcome. A page that did not leave is its own outcome,
 * never folded into `paged` (rule #11). */
export type OpsPagerOutcome = 'paged' | 'already_paged' | 'page_failed' | 'page_not_configured';

/** The port a writer with no database of its own pages through. */
export interface OpsPager {
  page(page: OpsPage): Promise<OpsPagerOutcome>;
}

/** Serializes crisis claims for one inbound across instances (pg_advisory_xact_lock's
 * first key; the second is the inbound key's hash). Any fixed 32-bit value. */
const CRISIS_CLAIM_LOCK_NS = 602_001;

/** A crisis with no provider inbound id: it is never keyed, so it never dedupes. */
export class CrisisInboundIdMissing extends Error {
  override name = 'CrisisInboundIdMissing';
}
/**
 * VIL-156 · families erased past their Google wait with Google unconfirmed (a revoke never
 * answered, or a local end that kept throwing). The claim row IS the record, as for a
 * first hello: the families it counts are gone. Identifier `<run uuid>:<unconfirmed>:<end
 * failed>`, counts only; count 0 is owed, 1 is paged.
 */
export const ERASURE_GOOGLE_PAGE_ROUTE = 'ops:erasure-google-unconfirmed';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The model these turns call. The classifier this page reuses is Anthropic's
 * error shape (credit balance, 401, 403).
 */
export const MODEL_PROVIDER = 'anthropic';

/**
 * One parent's deferral budget is retryLimit 8 (channel/config.ts). That many
 * `sms_turn_deferred` rows in an hour is a turn about to dead-letter, or
 * several turns failing together. Canary rows are not counted.
 */
export const DEFERRED_PILEUP_THRESHOLD = 8;
export const DEFERRED_PILEUP_WINDOW_MS = 60 * 60 * 1000;

/** Seven days: the turn ledger's own lookback, and past pg-boss's retry budget. */
export const FAILURE_PAGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** A claim left at a unix-second stamp for this long is a crashed poster. */
export const STALE_CLAIM_MS = 2 * 60 * 1000;

/** count = 1 means Slack accepted. Anything larger is an in-progress stamp. */
export const ALERTED_COUNT = 1;
const UNALERTED_COUNT = 0;

const MAX_PER_RUN = 50;

/** Fixed window so the unique index dedupes a subject instead of a clock bucket. */
export const CLAIM_EPOCH = new Date(0);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CRISIS_INBOUND_KEY_RE = /^[0-9a-f]{32}$/;

export interface FailurePageCounts {
  posted: number;
  deduped: number;
  failed: number;
}

export interface FailurePageResult {
  turns: FailurePageCounts;
  firstHellos: FailurePageCounts;
  providerIncidents: FailurePageCounts;
  deadLetters: FailurePageCounts;
  deferredPileups: FailurePageCounts;
  crisisUnanswered: FailurePageCounts;
  optOutHolds: FailurePageCounts;
  erasureGoogle: FailurePageCounts;
}

export interface FailurePageDeps {
  post?: (text: string) => Promise<OpsPageOutcome>;
  now?: Date;
}

/**
 * A category safe to put in Slack and in a rate_limits key. Letters, digits,
 * underscores. A run of 7+ digits is a phone-shaped leak (a provider code is
 * shorter) and becomes `redacted` rather than travelling.
 */
export function failureCategory(value: string): string {
  if (/\d{7,}/.test(value)) return 'redacted';
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!cleaned || /\d{7,}/.test(cleaned)) return 'redacted';
  return cleaned;
}

/** Linq's code when the throw is one, otherwise the error's name. Never its message. */
export function firstHelloFailureCategory(err: unknown): string {
  const refusal = readSendRefusal(err);
  if (refusal) return failureCategory(refusal.code);
  if (err instanceof Error && err.name) return failureCategory(err.name);
  return 'unknown';
}

function uuidOr(value: string | null, fallback: string): string {
  if (value !== null && UUID_RE.test(value)) return value;
  return fallback;
}

export function composeTurnFailureAlert(input: {
  familyId: string;
  category: string;
  messageId: string | null;
}): string {
  const parts = [
    'Hale: text turn failed.',
    `family ${uuidOr(input.familyId, 'invalid')}.`,
    `category ${failureCategory(input.category)}.`,
  ];
  if (input.messageId && UUID_RE.test(input.messageId)) {
    parts.push(`message ${input.messageId}.`);
  }
  return parts.join(' ');
}

export function composeFirstHelloFailureAlert(input: {
  familyId: string | null;
  sessionId: string;
  category: string;
}): string {
  return [
    'Hale: first hello failed.',
    `family ${uuidOr(input.familyId, 'none')}.`,
    `session ${uuidOr(input.sessionId, 'invalid')}.`,
    `category ${failureCategory(input.category)}.`,
  ].join(' ');
}

export function composeProviderIncidentAlert(input: {
  provider: string;
  failure: string;
  affectedTurns: number;
}): string {
  const turns =
    Number.isSafeInteger(input.affectedTurns) && input.affectedTurns >= 0
      ? String(input.affectedTurns)
      : '0';
  return [
    'Hale: provider call failed.',
    `provider ${failureCategory(input.provider)}.`,
    `class ${failureCategory(input.failure)}.`,
    `affected turns ${turns}.`,
  ].join(' ');
}

/** A job id safe to put in Slack. A uuid, or a short token with no phone-length digit run. */
function safeInternalId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (UUID_RE.test(value)) return value;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(value) && !/\d{7,}/.test(value)) return value;
  return null;
}

export function composeDeadLetterAlert(input: {
  familyId: string;
  channelMessageId: string;
  jobId?: string | null;
}): string {
  const parts = [
    'Hale: inbound turn dead-lettered.',
    `family ${uuidOr(input.familyId, 'invalid')}.`,
    `message ${uuidOr(input.channelMessageId, 'invalid')}.`,
  ];
  const jobId = safeInternalId(input.jobId);
  if (jobId) parts.push(`job ${jobId}.`);
  return parts.join(' ');
}

export function composeDeferredPileupAlert(input: {
  count: number;
  windowMinutes: number;
}): string {
  const count = Number.isSafeInteger(input.count) && input.count >= 0 ? String(input.count) : '0';
  const windowMinutes =
    Number.isSafeInteger(input.windowMinutes) && input.windowMinutes > 0
      ? String(input.windowMinutes)
      : '0';
  return `Hale: deferred turns piled up. count ${count}. window ${windowMinutes}m.`;
}

function pageCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : '0';
}

/** Counts only: no phone hash, no provider id, no family id. */
export function composeOptOutHoldAlert(input: {
  messages: number;
  numbers: number;
  notInLedger: number;
  legacy: number;
  oldestHours: number;
}): string {
  return [
    'Hale: opt-out reads held.',
    `messages ${pageCount(input.messages)}.`,
    `numbers ${pageCount(input.numbers)}.`,
    `not in ledger ${pageCount(input.notInLedger)}.`,
    `legacy ${pageCount(input.legacy)}.`,
    `oldest ${pageCount(input.oldestHours)}h.`,
  ].join(' ');
}

/** Counts only: no family, integration or user id. */
export function composeErasureGoogleAlert(input: {
  unconfirmed: number;
  endFailed: number;
}): string {
  return [
    'Hale: families erased with Google unconfirmed.',
    `revoke unanswered ${pageCount(input.unconfirmed)}.`,
    `end failed ${pageCount(input.endFailed)}.`,
  ].join(' ');
}

function parseErasureGoogleIdentifier(
  identifier: string,
): { unconfirmed: number; endFailed: number } | null {
  const [runId, unconfirmed, endFailed, ...rest] = identifier.split(':');
  if (!runId || !UUID_RE.test(runId) || rest.length > 0) return null;
  if (!/^\d+$/.test(unconfirmed ?? '') || !/^\d+$/.test(endFailed ?? '')) return null;
  return { unconfirmed: Number(unconfirmed), endFailed: Number(endFailed) };
}

export function composeCrisisUnansweredAlert(input: {
  kind: string;
  where: string;
  reason: string;
  writes: number;
  /** The crisis claim's rate_limits id: the one reference ops looks the crisis up by. */
  ref: string | null;
}): string {
  const writes =
    Number.isSafeInteger(input.writes) && input.writes >= 0 ? String(input.writes) : '0';
  return [
    'Hale: URGENT crisis flagged, no reply sent.',
    `kind ${failureCategory(input.kind)}.`,
    `where ${failureCategory(input.where)}.`,
    `reason ${failureCategory(input.reason)}.`,
    `writes ${writes}.`,
    `ref ${uuidOr(input.ref, 'none')}.`,
  ].join(' ');
}

const REDACTED_FACTS_KEY = 'redacted';

/** The facts on the site's list travel. Any other key, or a value off its key's list, does
 * not: a value is shown as `redacted`, a key is dropped, and how many were is the
 * `redacted` fact. */
function opsPageFacts(page: OpsPage): Array<[string, string]> {
  const vocabulary: Readonly<Record<string, readonly string[]>> =
    OPS_PAGE_VOCABULARY[page.site] ?? {};
  let redacted = 0;
  const shown: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(page.facts as Readonly<Record<string, unknown>>)) {
    const allowed = Object.hasOwn(vocabulary, key) ? vocabulary[key] : undefined;
    if (allowed === undefined) {
      redacted += 1;
    } else if (typeof value === 'string' && allowed.includes(value)) {
      shown.push([key, value]);
    } else {
      redacted += 1;
      shown.push([key, 'redacted']);
    }
  }
  return redacted > 0 ? [...shown, [REDACTED_FACTS_KEY, String(redacted)]] : shown;
}

export function composeOpsPageAlert(page: OpsPage): string {
  return [
    'Hale: ops page.',
    `site ${failureCategory(page.site)}.`,
    ...opsPageFacts(page).map(([key, value]) => `${key} ${value}.`),
  ].join(' ');
}

/** Fixed-shape, so the identifier parses; the provider's id is never stored as is. An
 * empty id has no key: hashing it would make every such crisis one inbound. The id is
 * hashed exactly as given, never trimmed, so {@link crisisInboundKeySql} over the stored
 * id is the same key. */
function crisisInboundKey(inboundId: string): string {
  if (inboundId.trim() === '') throw new CrisisInboundIdMissing('crisis inbound id is empty');
  return createHash('sha256').update(inboundId).digest('hex').slice(0, 32);
}

/** {@link crisisInboundKey}, computed in SQL over a stored provider id. */
function crisisInboundKeySql(providerMessageId: SQLWrapper): SQL {
  return sql`left(encode(sha256(convert_to(${providerMessageId}, 'UTF8')), 'hex'), 32)`;
}

/** A language tag fit to keep with a held text: never a word of it. */
const HELD_LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

function crisisIdentifier(key: string, alert: CrisisUnanswered): string {
  return [
    key,
    failureCategory(alert.kind),
    failureCategory(alert.where),
    failureCategory(alert.reason),
    String(alert.writes),
  ].join(':');
}

function parseCrisisIdentifier(
  identifier: string,
): { kind: string; where: string; reason: string; writes: number } | null {
  const [key, kind, where, reason, writes, ...rest] = identifier.split(':');
  if (rest.length > 0 || !key || !CRISIS_INBOUND_KEY_RE.test(key)) return null;
  if (!kind || !where || !reason || !writes || !/^\d$/.test(writes)) return null;
  return { kind, where, reason, writes: Number(writes) };
}

function providerIncidentWindow(now: Date): Date {
  const windowMs = PROVIDER_INCIDENT_WINDOW_HOURS * 3_600_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function hourWindowStart(now: Date): Date {
  return new Date(
    Math.floor(now.getTime() / DEFERRED_PILEUP_WINDOW_MS) * DEFERRED_PILEUP_WINDOW_MS,
  );
}

/** No canary household can exist without the encryption key its blind index needs.
 * When the key is unset the predicate is true and every row counts. */
function excludingCanary(actor: SQL | unknown): SQL {
  if (!process.env.APP_ENCRYPTION_KEY) return sql`true`;
  return notCanaryTraffic(actor);
}

function emptyCounts(): FailurePageCounts {
  return { posted: 0, deduped: 0, failed: 0 };
}

export function claimStamp(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function helloIdentifier(sessionId: string, category: string): string {
  return `${sessionId}:${category}`;
}

export function parseHelloIdentifier(
  identifier: string,
): { sessionId: string; category: string } | null {
  const split = identifier.indexOf(':');
  if (split <= 0) return null;
  const sessionId = identifier.slice(0, split);
  const category = identifier.slice(split + 1);
  if (!UUID_RE.test(sessionId) || !category) return null;
  return { sessionId, category: failureCategory(category) };
}

async function releaseStaleClaims(database: Database, now: Date): Promise<void> {
  const staleBefore = claimStamp(new Date(now.getTime() - STALE_CLAIM_MS));
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, TURN_FAILURE_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  await database
    .update(schema.rateLimits)
    .set({ count: UNALERTED_COUNT })
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  // Provider and pile-up claims are the "already paged" mark. The rows they
  // describe live in audit_log, so a crashed poster is deleted and the next
  // sweep inserts again. Scoped to these routes: a real rate-limit counter
  // also stores counts above 1, and must not be swept up.
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, PROVIDER_INCIDENT_PAGE_ROUTE),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, DEFERRED_PILEUP_PAGE_ROUTE),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, OPT_OUT_HOLD_PAGE_ROUTE),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  // The retired late-crisis count (nothing writes it now): rows already written go after
  // a day, so no mark of one parent's crisis outlives it.
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, OPT_OUT_LATE_CRISIS_ROUTE),
        lt(schema.rateLimits.windowStart, new Date(now.getTime() - DAY_MS)),
      ),
    );
  // A dead letter's claim row IS the record, same as a first hello. Reset it.
  await database
    .update(schema.rateLimits)
    .set({ count: UNALERTED_COUNT })
    .where(
      and(
        eq(schema.rateLimits.route, DEAD_LETTER_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  // So is an unanswered crisis's, whatever its window.
  await database
    .update(schema.rateLimits)
    .set({ count: UNALERTED_COUNT })
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  const lookback = new Date(now.getTime() - FAILURE_PAGE_LOOKBACK_MS);
  // A paged crisis claim is kept for the lookback, then goes, so no mark of one parent's
  // crisis outlives it. An owed one (count 0) is never deleted: it keeps paging. Neither a
  // claim nor a reply mark goes while its text is still held: the recovery pass reads them
  // so it never re-reads, re-pages or re-answers that text.
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE),
        eq(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.windowStart, lookback),
        notStillHeld(sql`split_part(${schema.rateLimits.identifier}, ':', 1)`),
      ),
    );
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_ANSWERED_ROUTE),
        lt(schema.rateLimits.windowStart, lookback),
        notStillHeld(sql`${schema.rateLimits.identifier}`),
      ),
    );
  // An ops page claim is only the "already paged" mark, like a pile-up's.
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, OPS_PAGE_ROUTE),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  // And an erasure's unconfirmed Google.
  await database
    .update(schema.rateLimits)
    .set({ count: UNALERTED_COUNT })
    .where(
      and(
        eq(schema.rateLimits.route, ERASURE_GOOGLE_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  await database
    .delete(schema.rateLimits)
    .where(
      and(eq(schema.rateLimits.route, OPS_PAGE_ROUTE), lt(schema.rateLimits.windowStart, lookback)),
    );
}

/**
 * An erasure's crisis claims and reply marks: every one keyed by an inbound text the erased
 * families sent. Run BEFORE the family cascade (rights/delete.ts): it deletes the ledger rows
 * whose provider ids are the keys. A claim still owed goes too: the parent it would page
 * about asked for everything to go.
 */
export async function releaseErasedCrisisMarks(
  database: Database,
  familyIds: readonly string[],
): Promise<void> {
  if (familyIds.length === 0) return;
  const inbound = schema.channelMessages;
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        inArray(schema.rateLimits.route, [CRISIS_UNANSWERED_PAGE_ROUTE, CRISIS_ANSWERED_ROUTE]),
        sql`split_part(${schema.rateLimits.identifier}, ':', 1) in (select ${crisisInboundKeySql(inbound.providerMessageId)} from ${inbound} where ${inArray(inbound.familyId, [...familyIds])} and ${inbound.direction} = 'in' and ${inbound.providerMessageId} is not null)`,
      ),
    );
}

/** No held text has this inbound key. */
function notStillHeld(key: SQL): SQL {
  return sql`not exists (select 1 from ${schema.optOutHeldMessages} where ${crisisInboundKeySql(schema.optOutHeldMessages.providerMessageId)} = ${key})`;
}

async function claimInsert(
  database: Database,
  route: string,
  identifier: string,
  stamp: number,
  windowStart: Date = CLAIM_EPOCH,
): Promise<boolean> {
  const inserted = await database
    .insert(schema.rateLimits)
    .values({
      identifier,
      route,
      windowStart,
      count: stamp,
    })
    .onConflictDoNothing({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
    })
    .returning({ id: schema.rateLimits.id });
  return inserted.length > 0;
}

async function claimHello(database: Database, identifier: string, stamp: number): Promise<boolean> {
  const claimed = await database
    .update(schema.rateLimits)
    .set({ count: stamp })
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.identifier, identifier),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .returning({ id: schema.rateLimits.id });
  return claimed.length > 0;
}

/** Take an owed (count 0) claim on `route`. False when it is paged or being paged. */
async function claimOwed(
  database: Database,
  route: string,
  identifier: string,
  stamp: number,
  windowStart: Date,
): Promise<boolean> {
  const claimed = await database
    .update(schema.rateLimits)
    .set({ count: stamp })
    .where(
      and(
        eq(schema.rateLimits.route, route),
        eq(schema.rateLimits.identifier, identifier),
        eq(schema.rateLimits.windowStart, windowStart),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .returning({ id: schema.rateLimits.id });
  return claimed.length > 0;
}

async function finishClaim(
  database: Database,
  route: string,
  identifier: string,
  stamp: number,
  posted: boolean,
  windowStart: Date = CLAIM_EPOCH,
): Promise<void> {
  const claim = and(
    eq(schema.rateLimits.route, route),
    eq(schema.rateLimits.identifier, identifier),
    eq(schema.rateLimits.windowStart, windowStart),
    eq(schema.rateLimits.count, stamp),
  );
  if (posted) {
    await database.update(schema.rateLimits).set({ count: ALERTED_COUNT }).where(claim);
    return;
  }
  // First hellos, dead letters, crises and erasures keep the row: count 0 means "still owed".
  if (
    route === FIRST_HELLO_PAGE_ROUTE ||
    route === DEAD_LETTER_PAGE_ROUTE ||
    route === CRISIS_UNANSWERED_PAGE_ROUTE ||
    route === ERASURE_GOOGLE_PAGE_ROUTE
  ) {
    await database.update(schema.rateLimits).set({ count: UNALERTED_COUNT }).where(claim);
    return;
  }
  await database.delete(schema.rateLimits).where(claim);
}

interface TurnCandidate {
  id: string;
  familyId: string;
  messageId: string | null;
  category: string;
  occurredAt: Date | null;
}

function asTurnCandidate(row: Record<string, unknown>): TurnCandidate | null {
  if (row.actionTaken !== undefined && row.actionTaken !== TURN_FAILED_AUDIT_ACTION) return null;
  if (typeof row.id !== 'string' || typeof row.familyId !== 'string') return null;
  let category = 'unknown';
  if (typeof row.reason === 'string') category = row.reason;
  else if (row.after && typeof row.after === 'object' && 'reason' in row.after) {
    const reason = (row.after as { reason: unknown }).reason;
    if (typeof reason === 'string') category = reason;
  }
  const occurredAt = row.occurredAt instanceof Date ? row.occurredAt : null;
  const messageId = typeof row.targetId === 'string' ? row.targetId : null;
  return { id: row.id, familyId: row.familyId, messageId, category, occurredAt };
}

async function loadTurnCandidates(database: Database, now: Date): Promise<TurnCandidate[]> {
  const since = new Date(now.getTime() - FAILURE_PAGE_LOOKBACK_MS);
  const rows = await database
    .select({
      id: schema.auditLog.id,
      familyId: schema.auditLog.familyId,
      targetId: schema.auditLog.targetId,
      actionTaken: schema.auditLog.actionTaken,
      occurredAt: schema.auditLog.occurredAt,
      after: schema.auditLog.after,
      reason: sql<string | null>`${schema.auditLog.after} ->> 'reason'`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_FAILED_AUDIT_ACTION),
        gte(schema.auditLog.occurredAt, since),
        sql`not exists (
          select 1 from ${schema.rateLimits}
          where ${schema.rateLimits.identifier} = ${schema.auditLog.id}::text
            and ${schema.rateLimits.route} = ${TURN_FAILURE_PAGE_ROUTE}
            and ${schema.rateLimits.windowStart} = ${CLAIM_EPOCH}
            and ${schema.rateLimits.count} = ${ALERTED_COUNT}
        )`,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt))
    .limit(MAX_PER_RUN);

  const candidates: TurnCandidate[] = [];
  for (const row of rows) {
    const candidate = asTurnCandidate(row as unknown as Record<string, unknown>);
    if (!candidate) continue;
    if (candidate.occurredAt && candidate.occurredAt.getTime() < since.getTime()) continue;
    candidates.push(candidate);
  }
  return candidates;
}

async function familyIdForSession(database: Database, sessionId: string): Promise<string | null> {
  const rows = await database
    .select({
      id: schema.smsIntakeSessions.id,
      familyId: schema.smsIntakeSessions.familyId,
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.id, sessionId))
    .limit(1);
  const match = rows.find((row) => row.id === sessionId);
  return match?.familyId ?? null;
}

interface HelloCandidate {
  identifier: string;
  sessionId: string;
  category: string;
}

async function loadHelloCandidates(database: Database): Promise<HelloCandidate[]> {
  const rows = await database
    .select({
      identifier: schema.rateLimits.identifier,
      route: schema.rateLimits.route,
      count: schema.rateLimits.count,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .limit(MAX_PER_RUN);

  const candidates: HelloCandidate[] = [];
  for (const row of rows) {
    if (row.route !== FIRST_HELLO_PAGE_ROUTE || row.count !== UNALERTED_COUNT) continue;
    const parsed = parseHelloIdentifier(row.identifier);
    if (!parsed) continue;
    candidates.push({ identifier: row.identifier, ...parsed });
    if (candidates.length >= MAX_PER_RUN) break;
  }
  return candidates;
}

async function postAlert(
  post: (text: string) => Promise<OpsPageOutcome>,
  route: string,
  text: string,
): Promise<OpsPageOutcome> {
  try {
    return await post(text);
  } catch (err) {
    console.error('failure page: post threw', {
      route,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}

async function deliver(
  database: Database,
  route: string,
  identifier: string,
  text: string,
  stamp: number,
  post: (text: string) => Promise<OpsPageOutcome>,
  counts: FailurePageCounts,
  windowStart: Date = CLAIM_EPOCH,
): Promise<OpsPageOutcome> {
  const outcome = await postAlert(post, route, text);
  const posted = outcome === 'sent';
  try {
    await finishClaim(database, route, identifier, stamp, posted, windowStart);
  } catch (err) {
    console.error('failure page: claim finish threw', {
      route,
      posted,
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  if (posted) counts.posted += 1;
  else counts.failed += 1;
  return outcome;
}

async function pageTurns(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const candidates = await loadTurnCandidates(database, now);
  const stamp = claimStamp(now);
  for (const candidate of candidates) {
    const claimed = await claimInsert(database, TURN_FAILURE_PAGE_ROUTE, candidate.id, stamp);
    if (!claimed) {
      counts.deduped += 1;
      continue;
    }
    const text = composeTurnFailureAlert({
      familyId: candidate.familyId,
      category: candidate.category,
      messageId: candidate.messageId,
    });
    await deliver(database, TURN_FAILURE_PAGE_ROUTE, candidate.id, text, stamp, post, counts);
  }
}

async function pageHellos(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const candidates = await loadHelloCandidates(database);
  const stamp = claimStamp(now);
  for (const candidate of candidates) {
    const claimed = await claimHello(database, candidate.identifier, stamp);
    if (!claimed) {
      counts.deduped += 1;
      continue;
    }
    const familyId = await familyIdForSession(database, candidate.sessionId);
    const text = composeFirstHelloFailureAlert({
      familyId,
      sessionId: candidate.sessionId,
      category: candidate.category,
    });
    await deliver(
      database,
      FIRST_HELLO_PAGE_ROUTE,
      candidate.identifier,
      text,
      stamp,
      post,
      counts,
    );
  }
}

async function countDistinctDeferredTurns(
  database: Database,
  failure: IncidentFailure,
  since: Date,
): Promise<number> {
  const rows = await database
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_DEFERRED_AUDIT_ACTION),
        gte(schema.auditLog.occurredAt, since),
        sql`${schema.auditLog.after} ->> 'providerFailure' = ${failure}`,
        excludingCanary(schema.auditLog.actor),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.targetId === 'string' && UUID_RE.test(row.targetId)) ids.add(row.targetId);
  }
  return ids.size;
}

async function pageProviderIncidents(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const windowStart = providerIncidentWindow(now);
  const stamp = claimStamp(now);
  for (const failure of INCIDENT_FAILURES) {
    const affected = await countDistinctDeferredTurns(database, failure, windowStart);
    if (affected < 1) continue;
    const identifier = `${MODEL_PROVIDER}:${failure}`;
    const claimed = await claimInsert(
      database,
      PROVIDER_INCIDENT_PAGE_ROUTE,
      identifier,
      stamp,
      windowStart,
    );
    if (!claimed) {
      counts.deduped += 1;
      continue;
    }
    const text = composeProviderIncidentAlert({
      provider: MODEL_PROVIDER,
      failure,
      affectedTurns: affected,
    });
    await deliver(
      database,
      PROVIDER_INCIDENT_PAGE_ROUTE,
      identifier,
      text,
      stamp,
      post,
      counts,
      windowStart,
    );
  }
}

export function parseDeadLetterIdentifier(identifier: string): {
  familyId: string;
  channelMessageId: string;
  jobId: string | null;
} | null {
  const parts = identifier.split(':');
  if (parts.length < 2) return null;
  const familyId = parts[0] ?? '';
  const channelMessageId = parts[1] ?? '';
  if (!UUID_RE.test(familyId) || !UUID_RE.test(channelMessageId)) return null;
  const jobId = parts.length > 2 ? safeInternalId(parts.slice(2).join(':')) : null;
  return { familyId, channelMessageId, jobId };
}

async function loadDeadLetterCandidates(
  database: Database,
): Promise<
  Array<{ identifier: string; familyId: string; channelMessageId: string; jobId: string | null }>
> {
  const rows = await database
    .select({
      identifier: schema.rateLimits.identifier,
      route: schema.rateLimits.route,
      count: schema.rateLimits.count,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, DEAD_LETTER_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .limit(MAX_PER_RUN);

  const candidates = [];
  for (const row of rows) {
    if (row.route !== DEAD_LETTER_PAGE_ROUTE || row.count !== UNALERTED_COUNT) continue;
    const parsed = parseDeadLetterIdentifier(row.identifier);
    if (!parsed) continue;
    candidates.push({ identifier: row.identifier, ...parsed });
    if (candidates.length >= MAX_PER_RUN) break;
  }
  return candidates;
}

async function pageDeadLetters(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const candidates = await loadDeadLetterCandidates(database);
  const stamp = claimStamp(now);
  for (const candidate of candidates) {
    const claimed = await database
      .update(schema.rateLimits)
      .set({ count: stamp })
      .where(
        and(
          eq(schema.rateLimits.route, DEAD_LETTER_PAGE_ROUTE),
          eq(schema.rateLimits.identifier, candidate.identifier),
          eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
          eq(schema.rateLimits.count, UNALERTED_COUNT),
        ),
      )
      .returning({ id: schema.rateLimits.id });
    if (claimed.length === 0) {
      counts.deduped += 1;
      continue;
    }
    const text = composeDeadLetterAlert({
      familyId: candidate.familyId,
      channelMessageId: candidate.channelMessageId,
      jobId: candidate.jobId,
    });
    await deliver(
      database,
      DEAD_LETTER_PAGE_ROUTE,
      candidate.identifier,
      text,
      stamp,
      post,
      counts,
    );
  }
}

async function pageCrisesUnanswered(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const rows = await database
    .select({
      id: schema.rateLimits.id,
      identifier: schema.rateLimits.identifier,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .limit(MAX_PER_RUN);
  const stamp = claimStamp(now);
  for (const row of rows) {
    let recorded = parseCrisisIdentifier(row.identifier);
    if (
      !(await claimOwed(
        database,
        CRISIS_UNANSWERED_PAGE_ROUTE,
        row.identifier,
        stamp,
        row.windowStart,
      ))
    ) {
      counts.deduped += 1;
      continue;
    }
    // Still a crisis nobody answered: a human hears of it even when its details are lost.
    if (!recorded) {
      console.error(
        { outcome: 'unreadable', claimId: row.id },
        'failure page: crisis claim unreadable - paging it as is',
      );
      recorded = { kind: 'unreadable', where: 'unreadable', reason: 'unreadable', writes: 0 };
    }
    const text = composeCrisisUnansweredAlert({ ...recorded, ref: row.id });
    await deliver(
      database,
      CRISIS_UNANSWERED_PAGE_ROUTE,
      row.identifier,
      text,
      stamp,
      post,
      counts,
      row.windowStart,
    );
  }
}

async function countDeferredRows(database: Database, since: Date): Promise<number> {
  const rows = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_DEFERRED_AUDIT_ACTION),
        gte(schema.auditLog.occurredAt, since),
        excludingCanary(schema.auditLog.actor),
      ),
    );
  return rows.length;
}

async function pageDeferredPileup(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const windowStart = hourWindowStart(now);
  const count = await countDeferredRows(database, windowStart);
  if (count < DEFERRED_PILEUP_THRESHOLD) return;
  const stamp = claimStamp(now);
  const claimed = await claimInsert(
    database,
    DEFERRED_PILEUP_PAGE_ROUTE,
    'deferred',
    stamp,
    windowStart,
  );
  if (!claimed) {
    counts.deduped += 1;
    return;
  }
  const text = composeDeferredPileupAlert({
    count,
    windowMinutes: DEFERRED_PILEUP_WINDOW_MS / 60_000,
  });
  await deliver(
    database,
    DEFERRED_PILEUP_PAGE_ROUTE,
    'deferred',
    text,
    stamp,
    post,
    counts,
    windowStart,
  );
}

/**
 * VIL-156 · every owed erasure claim, by count: a family erased past its Google wait with
 * Google unconfirmed. The claim row is the record, so a page Slack refused stays owed.
 */
async function pageErasureGoogle(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const rows = await database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, ERASURE_GOOGLE_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .limit(MAX_PER_RUN);
  const stamp = claimStamp(now);
  for (const row of rows) {
    if (
      !(await claimOwed(database, ERASURE_GOOGLE_PAGE_ROUTE, row.identifier, stamp, CLAIM_EPOCH))
    ) {
      counts.deduped += 1;
      continue;
    }
    // Families were erased with Google unconfirmed: a human hears of it even when the
    // counts are lost.
    const recorded = parseErasureGoogleIdentifier(row.identifier) ?? {
      unconfirmed: 0,
      endFailed: 0,
    };
    const text = composeErasureGoogleAlert(recorded);
    await deliver(database, ERASURE_GOOGLE_PAGE_ROUTE, row.identifier, text, stamp, post, counts);
  }
}

/**
 * VIL-553 · what stands in the two hold tables, by count. A hold row carries no family,
 * so canary traffic cannot be told apart here and nothing is excluded.
 */
async function pageOptOutHolds(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const messages = await database
    .select({
      phoneHash: schema.optOutHeldMessages.phoneHash,
      heldAt: schema.optOutHeldMessages.heldAt,
      ledgerId: schema.channelMessages.id,
    })
    .from(schema.optOutHeldMessages)
    .leftJoin(
      schema.channelMessages,
      and(
        eq(schema.channelMessages.providerMessageId, schema.optOutHeldMessages.providerMessageId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    );
  const legacy = await database
    .select({
      phoneHash: schema.optOutReadHolds.phoneHash,
      heldAt: schema.optOutReadHolds.heldAt,
    })
    .from(schema.optOutReadHolds);
  const holds = [...messages, ...legacy];
  if (holds.length === 0) return;

  const oldest = Math.min(...holds.map((row) => row.heldAt.getTime()));
  const fresh = holds.some((row) => now.getTime() - row.heldAt.getTime() < HOUR_MS);
  const windowMs = fresh ? HOUR_MS : DAY_MS;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  // Two subjects, so a standing day's claim at 00:00 cannot swallow a new hold's hour.
  const identifier = fresh ? 'new' : 'standing';
  const stamp = claimStamp(now);
  if (!(await claimInsert(database, OPT_OUT_HOLD_PAGE_ROUTE, identifier, stamp, windowStart))) {
    counts.deduped += 1;
    return;
  }
  const text = composeOptOutHoldAlert({
    messages: messages.length,
    numbers: new Set(holds.map((row) => row.phoneHash)).size,
    notInLedger: messages.filter((row) => row.ledgerId === null).length,
    legacy: legacy.length,
    oldestHours: Math.floor((now.getTime() - oldest) / HOUR_MS),
  });
  await deliver(
    database,
    OPT_OUT_HOLD_PAGE_ROUTE,
    identifier,
    text,
    stamp,
    post,
    counts,
    windowStart,
  );
}

/**
 * Post every unalerted failure once. Never throws: a sweep that escapes would
 * turn the cron red and, on the inline path, a turn that already answered.
 */
export async function pageFailureAlerts(
  database: Database,
  deps: FailurePageDeps = {},
): Promise<FailurePageResult> {
  const now = deps.now ?? new Date();
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const result: FailurePageResult = {
    turns: emptyCounts(),
    firstHellos: emptyCounts(),
    providerIncidents: emptyCounts(),
    deadLetters: emptyCounts(),
    deferredPileups: emptyCounts(),
    crisisUnanswered: emptyCounts(),
    optOutHolds: emptyCounts(),
    erasureGoogle: emptyCounts(),
  };
  try {
    await releaseStaleClaims(database, now);
  } catch (err) {
    console.error('failure page: stale claim release threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageCrisesUnanswered(database, post, now, result.crisisUnanswered);
  } catch (err) {
    console.error('failure page: crisis sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageTurns(database, post, now, result.turns);
  } catch (err) {
    console.error('failure page: turn sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageHellos(database, post, now, result.firstHellos);
  } catch (err) {
    console.error('failure page: first hello sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageProviderIncidents(database, post, now, result.providerIncidents);
  } catch (err) {
    console.error('failure page: provider incident sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageDeadLetters(database, post, now, result.deadLetters);
  } catch (err) {
    console.error('failure page: dead-letter sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageDeferredPileup(database, post, now, result.deferredPileups);
  } catch (err) {
    console.error('failure page: deferred pile-up sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageOptOutHolds(database, post, now, result.optOutHolds);
  } catch (err) {
    console.error('failure page: opt-out hold sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageErasureGoogle(database, post, now, result.erasureGoogle);
  } catch (err) {
    console.error('failure page: erasure google sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  return result;
}

/**
 * VIL-156 · one family erased past its Google wait with Google unconfirmed. Recorded in
 * the caller's transaction, beside the family's DELETE, so the page cannot be lost to a
 * throw later in the sweep: the claim is owed until a page leaves.
 */
export async function recordErasureGoogleUnconfirmed(
  database: Database,
  input: { unconfirmed: number; endFailed: number },
): Promise<void> {
  await database.insert(schema.rateLimits).values({
    identifier: `${randomUUID()}:${pageCount(input.unconfirmed)}:${pageCount(input.endFailed)}`,
    route: ERASURE_GOOGLE_PAGE_ROUTE,
    windowStart: CLAIM_EPOCH,
    count: UNALERTED_COUNT,
  });
}

/** Page every owed erasure claim now. One that does not leave stays owed, and the
 * failure-page cron retries it. */
export async function pageErasureGoogleUnconfirmed(
  database: Database,
  deps: FailurePageDeps = {},
): Promise<FailurePageCounts> {
  const now = deps.now ?? new Date();
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const counts = emptyCounts();
  await pageErasureGoogle(database, post, now, counts);
  return counts;
}

/**
 * Remember a first hello that did not leave, then page it (and any other
 * unalerted failure). One session records one row; a second failure of the
 * same session does not add another category. Invalid ids are refused — a
 * phone number must not be able to land in the claim key.
 */
export async function noteFirstHelloFailure(
  database: Database,
  input: { sessionId: string; familyId: string | null; category: string },
  deps: FailurePageDeps = {},
): Promise<FailurePageResult> {
  const sessionId = input.sessionId;
  if (!UUID_RE.test(sessionId)) {
    console.error('failure page: first hello session id was not a uuid — not recorded');
    return pageFailureAlerts(database, deps);
  }
  if (input.familyId !== null && !UUID_RE.test(input.familyId)) {
    console.error('failure page: first hello family id was not a uuid — not recorded');
    return pageFailureAlerts(database, deps);
  }
  const category = failureCategory(input.category);
  const identifier = helloIdentifier(sessionId, category);
  try {
    const existing = await database
      .select({
        identifier: schema.rateLimits.identifier,
        route: schema.rateLimits.route,
      })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE));
    const already = existing.some(
      (row) => row.route === FIRST_HELLO_PAGE_ROUTE && row.identifier.startsWith(`${sessionId}:`),
    );
    if (!already) {
      await database
        .insert(schema.rateLimits)
        .values({
          identifier,
          route: FIRST_HELLO_PAGE_ROUTE,
          windowStart: CLAIM_EPOCH,
          count: UNALERTED_COUNT,
        })
        .onConflictDoNothing({
          target: [
            schema.rateLimits.identifier,
            schema.rateLimits.route,
            schema.rateLimits.windowStart,
          ],
        });
    }
  } catch (err) {
    console.error('failure page: first hello record threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  return pageFailureAlerts(database, deps);
}

/**
 * An inbound turn that exhausted its deferrals. Records the claim, then pages
 * it (and any other unalerted failure). A canary household is named and skipped.
 * Invalid ids are refused — a phone number must not land in the claim key.
 * Never throws out of the drain: the caller still completes the dead letter.
 */
export async function noteDeadLetteredTurn(
  database: Database,
  input: { familyId: string; channelMessageId: string; jobId: string },
  deps: FailurePageDeps = {},
): Promise<FailurePageResult> {
  if (!UUID_RE.test(input.familyId) || !UUID_RE.test(input.channelMessageId)) {
    console.error('failure page: dead-letter ids were not uuids — not recorded');
    return pageFailureAlerts(database, deps);
  }
  try {
    const household = await canaryChannel(database);
    if (household?.familyId === input.familyId) {
      console.error('failure page: canary turn dead-lettered — not paged', { skipped: 'canary' });
      return pageFailureAlerts(database, deps);
    }
  } catch (err) {
    console.error('failure page: canary check threw — paging the dead letter', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  const jobId = safeInternalId(input.jobId);
  const identifier = jobId
    ? `${input.familyId}:${input.channelMessageId}:${jobId}`
    : `${input.familyId}:${input.channelMessageId}`;
  try {
    await database
      .insert(schema.rateLimits)
      .values({
        identifier,
        route: DEAD_LETTER_PAGE_ROUTE,
        windowStart: CLAIM_EPOCH,
        count: UNALERTED_COUNT,
      })
      .onConflictDoNothing({
        target: [
          schema.rateLimits.identifier,
          schema.rateLimits.route,
          schema.rateLimits.windowStart,
        ],
      });
  } catch (err) {
    console.error('failure page: dead-letter record threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  return pageFailureAlerts(database, deps);
}

function pagerOutcome(outcome: OpsPageOutcome): OpsPagerOutcome {
  if (outcome === 'sent') return 'paged';
  if (outcome === 'skipped_not_configured') return 'page_not_configured';
  return 'page_failed';
}

interface CrisisClaim {
  id: string;
  identifier: string;
  windowStart: Date;
}

/** What a crisis was read as, sealed for its held row. */
interface HeldCrisisRead {
  language: ReplyLanguage | null;
  situation: CrisisSituation | null;
  who: CrisisWho | null;
}

/**
 * What a crisis was read as, sealed for the held row of its text, never put on the claim:
 * it goes when the row goes (read, released or erased), so a later tick writes from the
 * same facts while the text is held, and nothing about the crisis outlives it. Null when
 * nothing was read, or when it cannot be sealed: the claim is recorded either way, and a
 * late reply is then written without the language, situation or who.
 */
function sealHeldCrisisRead(alert: CrisisUnanswered): string | null {
  const read: HeldCrisisRead = {
    language: alert.language && HELD_LANGUAGE_RE.test(alert.language) ? alert.language : null,
    situation: CRISIS_SITUATIONS.find((value) => value === alert.situation) ?? null,
    who: CRISIS_WHO.find((value) => value === alert.who) ?? null,
  };
  if (read.language === null && read.situation === null && read.who === null) return null;
  try {
    return encryptString(JSON.stringify(read));
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'crisis claim: read not sealed - kept without it',
    );
    return null;
  }
}

/** The sealed read, opened. Throws on a blob that does not decrypt (rule #1: never guessed). */
function openHeldCrisisRead(sealed: string | null): HeldCrisisRead {
  if (sealed === null) return { language: null, situation: null, who: null };
  const read = JSON.parse(decryptString(sealed)) as Partial<Record<keyof HeldCrisisRead, unknown>>;
  return {
    language:
      typeof read.language === 'string' && HELD_LANGUAGE_RE.test(read.language)
        ? read.language
        : null,
    situation: CRISIS_SITUATIONS.find((value) => value === read.situation) ?? null,
    who: CRISIS_WHO.find((value) => value === read.who) ?? null,
  };
}

/**
 * The claim for this inbound's crisis, recorded once: an owed row the sweep pages from.
 * Whichever delivery of the inbound recorded it, and for whatever reason, there is one row:
 * the lookup and the insert run under a per-inbound advisory lock. What the first record
 * read the text as goes on the text's held row, if it is held, in the same transaction.
 * The first record also writes the audit row when there is a family to write it against,
 * after the commit, so a failed audit write cannot roll the claim back.
 */
async function recordCrisisClaim(
  database: Database,
  alert: CrisisUnanswered,
  now: Date,
): Promise<CrisisClaim> {
  const key = crisisInboundKey(alert.inboundId);
  const sealedRead = sealHeldCrisisRead(alert);
  const { claim, inserted } = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(
      sql`select pg_advisory_xact_lock(${CRISIS_CLAIM_LOCK_NS}::int, hashtext(${key}))`,
    );
    const [prior] = await tx
      .select({
        id: schema.rateLimits.id,
        identifier: schema.rateLimits.identifier,
        windowStart: schema.rateLimits.windowStart,
      })
      .from(schema.rateLimits)
      .where(
        and(
          eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE),
          like(schema.rateLimits.identifier, `${key}:%`),
        ),
      )
      .limit(1);
    if (prior) return { claim: prior, inserted: false };
    const identifier = crisisIdentifier(key, alert);
    const [row] = await tx
      .insert(schema.rateLimits)
      .values({
        identifier,
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        windowStart: now,
        count: UNALERTED_COUNT,
      })
      .returning({
        id: schema.rateLimits.id,
        identifier: schema.rateLimits.identifier,
        windowStart: schema.rateLimits.windowStart,
      });
    if (!row) throw new Error('crisis claim insert returned no row');
    if (sealedRead !== null) {
      await tx
        .update(schema.optOutHeldMessages)
        .set({ crisisReadEncrypted: sealedRead })
        .where(eq(schema.optOutHeldMessages.providerMessageId, alert.inboundId));
    }
    return { claim: row, inserted: true };
  });
  if (inserted && alert.familyId !== null) {
    await auditCrisis(database, alert.familyId, alert);
  }
  return claim;
}

/** The claim for this inbound's crisis, recorded, then taken. Null when this inbound is
 * already paged, or another request is paging it now. */
async function claimCrisisPage(
  database: Database,
  alert: CrisisUnanswered,
  now: Date,
  stamp: number,
): Promise<CrisisClaim | null> {
  const claim = await recordCrisisClaim(database, alert, now);
  const claimed = await claimOwed(
    database,
    CRISIS_UNANSWERED_PAGE_ROUTE,
    claim.identifier,
    stamp,
    claim.windowStart,
  );
  return claimed ? claim : null;
}

/**
 * The crisis already recorded for this inbound, live or late: its claim id and kind, and
 * the language, situation and who it was first read with, from the text's held row. Null
 * when there is none (or the inbound has no id to key it by).
 */
export async function crisisClaimFor(
  database: Database,
  inboundId: string,
): Promise<{
  id: string;
  kind: CrisisKind;
  language: ReplyLanguage | null;
  situation: CrisisSituation | null;
  who: CrisisWho | null;
} | null> {
  if (inboundId.trim() === '') return null;
  const [row] = await database
    .select({ id: schema.rateLimits.id, identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE),
        like(schema.rateLimits.identifier, `${crisisInboundKey(inboundId)}:%`),
      ),
    )
    .limit(1);
  const kind = row ? parseCrisisIdentifier(row.identifier)?.kind : undefined;
  if (!row || (kind !== 'emergency' && kind !== 'mental')) return null;
  const [held] = await database
    .select({ sealed: schema.optOutHeldMessages.crisisReadEncrypted })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, inboundId))
    .limit(1);
  return { id: row.id, kind, ...openHeldCrisisRead(held?.sealed ?? null) };
}

/** A crisis reply's mark: taken as it leaves, and turned to sent once the transport accepted it. */
const REPLY_LEAVING_COUNT = UNALERTED_COUNT;
const REPLY_SENT_COUNT = ALERTED_COUNT;

/**
 * How long a leaving mark holds a held text back. The turn deadline does not cancel a send
 * (router/deadline.ts), so the lease outlives the process that took the mark: past the
 * drain's 800s maxDuration (app/api/cron/drain/route.ts), the longest any function runs.
 * By then its send has landed, failed or died with it. The recovery pass's first back-off
 * rests on the same bound.
 */
const CRISIS_REPLY_LEASE_MS = 15 * 60_000;

/**
 * Where the reply to one inbound's crisis stands (VIL-602). `answered` only once the
 * transport accepted it. `in_flight` while a leaving mark is within its lease: its send may
 * still land. Otherwise `unanswered`: no mark, or a leaving mark older than any process
 * that could still be sending, whose send failed, timed out or died with it. No reply is
 * known to have left, so the held text is answered late.
 */
export type CrisisReplyState = 'unanswered' | 'in_flight' | 'answered';

type ReplyMarkRow = { id: string; count: number; windowStart: Date };

function replyState(row: ReplyMarkRow | undefined, now: Date): CrisisReplyState {
  if (!row) return 'unanswered';
  if (row.count === REPLY_SENT_COUNT) return 'answered';
  return row.windowStart.getTime() > now.getTime() - CRISIS_REPLY_LEASE_MS
    ? 'in_flight'
    : 'unanswered';
}

async function replyMark(database: Database, key: string): Promise<ReplyMarkRow | undefined> {
  const [row] = await database
    .select({
      id: schema.rateLimits.id,
      count: schema.rateLimits.count,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_ANSWERED_ROUTE),
        eq(schema.rateLimits.identifier, key),
      ),
    )
    .limit(1);
  return row;
}

/** Runs `write` under the crisis claim's per-inbound lock, with this inbound's mark. */
async function underReplyLock<T>(
  database: Database,
  inboundId: string,
  write: (tx: Database, key: string, prior: ReplyMarkRow | undefined) => Promise<T>,
): Promise<T> {
  const key = crisisInboundKey(inboundId);
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(
      sql`select pg_advisory_xact_lock(${CRISIS_CLAIM_LOCK_NS}::int, hashtext(${key}))`,
    );
    return write(tx, key, await replyMark(tx, key));
  });
}

async function setReplyMark(
  tx: Database,
  key: string,
  prior: ReplyMarkRow | undefined,
  count: number,
  now: Date,
): Promise<void> {
  if (prior) {
    await tx
      .update(schema.rateLimits)
      .set({ count, windowStart: now })
      .where(eq(schema.rateLimits.id, prior.id));
    return;
  }
  await tx
    .insert(schema.rateLimits)
    .values({ identifier: key, route: CRISIS_ANSWERED_ROUTE, windowStart: now, count });
}

export async function crisisReplyState(
  database: Database,
  inboundId: string,
  now: Date,
): Promise<CrisisReplyState> {
  if (inboundId.trim() === '') return 'unanswered';
  return replyState(await replyMark(database, crisisInboundKey(inboundId)), now);
}

/**
 * Takes the leaving mark just before a send, so the recovery pass leaves the held copy of
 * the text alone while it is out. `claimed`: this call took it and may send. Otherwise the
 * state it found, and nothing is sent. Throws when it cannot be recorded.
 */
export async function claimCrisisReply(
  database: Database,
  inboundId: string,
  now: Date,
): Promise<'claimed' | 'in_flight' | 'answered'> {
  return underReplyLock(database, inboundId, async (tx, key, prior) => {
    const state = replyState(prior, now);
    if (state !== 'unanswered') return state;
    await setReplyMark(tx, key, prior, REPLY_LEAVING_COUNT, now);
    return 'claimed';
  });
}

/** The transport accepted the reply: only now is the crisis answered. Throws. */
export async function confirmCrisisReply(
  database: Database,
  inboundId: string,
  now: Date,
): Promise<void> {
  await underReplyLock(database, inboundId, (tx, key, prior) =>
    setReplyMark(tx, key, prior, REPLY_SENT_COUNT, now),
  );
}

/** The send threw: its leaving mark comes off, never a sent one. A mark that cannot be
 * removed goes stale after its lease, and the text is answered late. */
export async function releaseCrisisReply(database: Database, inboundId: string): Promise<void> {
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, CRISIS_ANSWERED_ROUTE),
        eq(schema.rateLimits.identifier, crisisInboundKey(inboundId)),
        eq(schema.rateLimits.count, REPLY_LEAVING_COUNT),
      ),
    );
}

export type CrisisReplyMark = 'marked' | 'already_marked' | 'not_marked';

/**
 * A live crisis reply is written and about to leave: the leaving mark. Never throws and
 * never holds the reply back; a mark that did not land is logged and named.
 */
export async function noteCrisisReplyLeaving(
  database: Database,
  inboundId: string,
  now: Date,
): Promise<CrisisReplyMark> {
  return noteReplyMark('leaving', inboundId, async () =>
    (await claimCrisisReply(database, inboundId, now)) === 'claimed' ? 'marked' : 'already_marked',
  );
}

/**
 * A live crisis reply the transport accepted: answered. Never throws. A mark that did not
 * land is logged and named; the held copy is then answered again late, two replies and
 * never none.
 */
export async function noteCrisisReplySent(
  database: Database,
  inboundId: string,
  now: Date,
): Promise<CrisisReplyMark> {
  return noteReplyMark('sent', inboundId, async () => {
    await confirmCrisisReply(database, inboundId, now);
    return 'marked';
  });
}

async function noteReplyMark(
  stage: 'leaving' | 'sent',
  inboundId: string,
  mark: () => Promise<CrisisReplyMark>,
): Promise<CrisisReplyMark> {
  if (inboundId.trim() === '') {
    console.error({ mark: 'not_marked', stage, reason: 'inbound_id_missing' }, 'crisis reply mark');
    return 'not_marked';
  }
  try {
    return await mark();
  } catch (err) {
    console.error(
      { mark: 'not_marked', stage, err: err instanceof Error ? err.name : 'unknown' },
      'crisis reply mark',
    );
    return 'not_marked';
  }
}

/**
 * Body-free (rule #1). It names the parent who texted, when known, and no family-wide
 * surface reads it (rights/export.ts, trail/verbs.ts INTERNAL_TRAIL_VERBS). A failed
 * write is logged and does not hold the page back.
 */
async function auditCrisis(
  database: Database,
  familyId: string,
  alert: CrisisUnanswered,
): Promise<void> {
  try {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: CRISIS_UNANSWERED_AUDIT_ACTION,
      ...(alert.parentUserId === null
        ? {}
        : { targetTable: 'users', targetId: alert.parentUserId }),
      after: { kind: alert.kind, where: alert.where, reason: alert.reason, writes: alert.writes },
    });
  } catch (err) {
    console.error('failure page: crisis audit row threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * A crisis was flagged and no reply went out: page #ops now, once per inbound. If the
 * claim cannot be recorded the page still goes, without one — a crisis never waits on
 * the ledger. A page that did not leave stays owed, and the sweep retries it.
 */
export async function noteCrisisUnanswered(
  database: Database,
  alert: CrisisUnanswered,
  deps: FailurePageDeps = {},
): Promise<CrisisPageOutcome> {
  const now = deps.now ?? new Date();
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const stamp = claimStamp(now);
  const { kind, where, reason } = alert;
  console.error(
    { kind, where, reason, writes: alert.writes },
    'URGENT: crisis flagged, no reply sent - paging #ops',
  );
  let claim: CrisisClaim | null;
  try {
    claim = await claimCrisisPage(database, alert, now, stamp);
  } catch (err) {
    console.error('failure page: crisis claim threw - paging without one', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    const unrecorded = composeCrisisUnansweredAlert({ ...alert, ref: null });
    return crisisPageResult(
      alert,
      pagerOutcome(await postAlert(post, CRISIS_UNANSWERED_PAGE_ROUTE, unrecorded)),
    );
  }
  if (claim === null) return 'already_paged';
  // The claim an earlier delivery recorded is the one paged, so the page says what the
  // sweep would have said.
  const text = composeCrisisUnansweredAlert({
    ...(parseCrisisIdentifier(claim.identifier) ?? alert),
    ref: claim.id,
  });
  return crisisPageResult(
    alert,
    pagerOutcome(
      await deliver(
        database,
        CRISIS_UNANSWERED_PAGE_ROUTE,
        claim.identifier,
        text,
        stamp,
        post,
        emptyCounts(),
        claim.windowStart,
      ),
    ),
  );
}

function crisisPageResult(alert: CrisisUnanswered, page: CrisisPageOutcome): CrisisPageOutcome {
  if (page === 'page_failed' || page === 'page_not_configured') {
    console.error(
      { kind: alert.kind, where: alert.where, reason: alert.reason, page },
      'URGENT: crisis page did not go out - nobody in #ops was told yet',
    );
  }
  return page;
}

/** The production crisis pager (said-line.ts's port). */
export function failurePageCrisisPager(
  database: Database,
  deps: FailurePageDeps = {},
): CrisisPager {
  return {
    record: async (alert) => {
      await recordCrisisClaim(database, alert, deps.now ?? new Date());
    },
    page: (alert) => noteCrisisUnanswered(database, alert, deps),
  };
}

/**
 * Process-local dedupe for an ops page whose claim insert threw (the database is
 * failing). Keyed on the same hour bucket as the claim, so a flood is still one page per
 * site per hour on this instance. Entries from older hours are pruned on insert.
 */
const opsPagesWithoutClaim = new Set<string>();

function takeInProcess(site: string, windowStart: Date): string | null {
  const hour = windowStart.toISOString();
  for (const key of opsPagesWithoutClaim) {
    if (!key.endsWith(`@${hour}`)) opsPagesWithoutClaim.delete(key);
  }
  const key = `${site}@${hour}`;
  if (opsPagesWithoutClaim.has(key)) return null;
  opsPagesWithoutClaim.add(key);
  return key;
}

/** A page with no claim row to take: deduped in this process only, per site and hour. */
async function pageWithoutClaim(page: OpsPage, deps: FailurePageDeps): Promise<OpsPagerOutcome> {
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const key = takeInProcess(failureCategory(page.site), hourWindowStart(deps.now ?? new Date()));
  if (key === null) return 'already_paged';
  const outcome = pagerOutcome(await postAlert(post, OPS_PAGE_ROUTE, composeOpsPageAlert(page)));
  if (outcome !== 'paged') opsPagesWithoutClaim.delete(key);
  return outcome;
}

/**
 * VIL-602 · the one way a path pages #ops. A body-free URGENT log, then a claim on
 * `ops:page` for this site and hour, then the post. A second page of the same site in the
 * same hour is `already_paged`; a post that did not leave releases the claim, so the next
 * occurrence tries again. Never throws.
 */
export async function pageOps(
  database: Database,
  page: OpsPage,
  deps: FailurePageDeps = {},
): Promise<OpsPagerOutcome> {
  const now = deps.now ?? new Date();
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const site = failureCategory(page.site);
  console.error(
    { ...Object.fromEntries(opsPageFacts(page)), page: site },
    `URGENT: ${site} - paging #ops`,
  );
  const text = composeOpsPageAlert(page);
  const windowStart = hourWindowStart(now);
  const stamp = claimStamp(now);
  let claimed: boolean;
  try {
    claimed = await claimInsert(database, OPS_PAGE_ROUTE, site, stamp, windowStart);
  } catch (err) {
    console.error(
      { page: site, err: err instanceof Error ? err.name : 'unknown' },
      'ops page: claim threw - deduped in this process only',
    );
    return pageWithoutClaim(page, deps);
  }
  if (!claimed) return 'already_paged';
  return pagerOutcome(
    await deliver(database, OPS_PAGE_ROUTE, site, text, stamp, post, emptyCounts(), windowStart),
  );
}

/** The ops pager for a writer that holds no database: resolved at page time. */
export function failurePageOpsPager(
  database: () => Database,
  deps: FailurePageDeps = {},
): OpsPager {
  return {
    async page(page) {
      let resolved: Database;
      try {
        resolved = database();
      } catch (err) {
        console.error(
          { page: failureCategory(page.site), err: err instanceof Error ? err.name : 'unknown' },
          'URGENT: ops page has no database - paging #ops, deduped in this process only',
        );
        return pageWithoutClaim(page, deps);
      }
      return pageOps(resolved, page, deps);
    },
  };
}

/** Inline hook. The cron is the backstop when this never runs or the post fails. */
export async function reportTurnFailures(database: Database): Promise<void> {
  try {
    await pageFailureAlerts(database);
  } catch (err) {
    console.error('failure page: inline turn sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** Inline hook for a greet / recovery send that threw. Never replaces that error. */
export async function reportFirstHelloFailure(
  database: Database,
  input: { sessionId: string; familyId: string | null; err: unknown },
): Promise<void> {
  try {
    await noteFirstHelloFailure(database, {
      sessionId: input.sessionId,
      familyId: input.familyId,
      category: firstHelloFailureCategory(input.err),
    });
  } catch (err) {
    console.error('failure page: inline first hello sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}
