import type { Database } from '@hale/db';
import { waitUntil } from '@vercel/functions';
import type { AnalyticsEvent } from '~/lib/analytics/events';
import {
  type CaptureOutcome,
  captureServerEvent,
  hashFamilyId,
} from '~/lib/analytics/server-capture';
import { type ClaimShadowContext, loadClaimShadowContext } from './candidate-rows';
import { buildClaimCandidates } from './candidates';
import {
  CLAIM_READ_MAX_BUDGET_MS,
  type ClaimReadFailure,
  type ClaimReadOutcome,
  type ClaimReader,
  READ_CLAIM_KINDS,
  type ReadClaimKind,
  defaultClaimReader,
} from './claim-reader';
import { verifyClaimRead } from './claim-verdict';
import type { StateClaim } from './claims';
import { type ClaimReaderMode, claimReaderMode } from './flag';
import type { SendRefusalReason } from './gate';
import type { ReconcileVerdict, ReconcileView, RefusalReason } from './reconcile';
import { claimReadLocale } from './sentences';

/**
 * VIL-581 · the claim reader in SHADOW: it reads what each lane's regex gate judged,
 * compares the two, and counts the comparison as one `agent_claim_shadow` event.
 *
 * ZERO EFFECT ON SENDS, BY CONSTRUCTION. Every caller computes and returns its regex
 * decision exactly as before, and only then hands this module a copy of it. `start` is
 * synchronous and never throws; the read runs detached (`waitUntil`), so no send waits
 * on it and nothing it learns flows back. The reader gets its own never-aborting signal
 * and the max budget, so a turn deadline cannot cut it and its own timer is its only
 * deadline.
 *
 * A BOUND ON READS, NOT SENDS. The reader shares the Haiku lane with the send-path
 * checkers, so at most CLAIM_SHADOW_MAX_IN_FLIGHT reads run per process. A start past it
 * makes no read and emits `shadow_busy`: the skip is named and counted (rule #11).
 *
 * A FAILURE IS NEVER A REFUSAL. A failed read, a missing zone and a bug inside the task
 * each have their own `reader_outcome`, with verdict `not_compared`.
 *
 * WHAT LEAVES: the hashed family, enums and counts. Never a body, a label, an alias, a
 * host or an id.
 */

/** ASSUMPTION (unmeasured): the shadow shares the production key's Haiku rate limit. */
export const CLAIM_SHADOW_MAX_IN_FLIGHT = 2;

export type ClaimShadowLane =
  | 'coach'
  | 'activity_followup'
  | 'followup_ask'
  | 'spot_open'
  | 'registration_sequence'
  | 'dispatch'
  /** A gated sweep that names no lane. */
  | 'sweep_unlabelled';

export type ClaimShadowStart = 'off' | 'busy' | 'started';

/** What the regex gate decided, as the caller already holds it. */
export type RegexSide =
  /** coach and sweeps; null: the body had no claim, so no query ran. */
  | { kind: 'verdict'; verdict: ReconcileVerdict | null }
  /** dispatch: claimsNoLedgerCanBack, every one refused. */
  | { kind: 'no_ledger'; claims: readonly StateClaim[] };

export interface RegexJudgement {
  sentence: string;
  kind: StateClaim['kind'];
  /** `unrecorded_promise`: a mint on a lane that cannot write it. */
  decision: 'sendable' | Exclude<SendRefusalReason, 'claim_read_failed'>;
}

/** One judgement per regex claim, in order, keeping the sentence the reconcile's own
 * reductions (unsendableReasons, the mint list) drop. */
export function regexJudgements(side: RegexSide, lane: ClaimShadowLane): readonly RegexJudgement[] {
  if (side.kind === 'no_ledger') {
    return side.claims.map((claim) => ({
      sentence: claim.sentence,
      kind: claim.kind,
      decision: claim.kind === 'co_parent_invite' ? 'no_coparent_invite' : 'self_referential',
    }));
  }
  if (side.verdict === null) return [];
  return side.verdict.resolutions.map((resolution) => ({
    sentence: resolution.claim.sentence,
    kind: resolution.claim.kind,
    decision:
      resolution.status === 'matched'
        ? 'sendable'
        : resolution.status === 'refused'
          ? resolution.reason
          : lane === 'coach'
            ? 'sendable'
            : 'unrecorded_promise',
  }));
}

/** Structural: the route passes each attempt's ChannelTurnResult and its verdict. */
export interface CoachShadowAttempt {
  reply: string;
  experienceCard?: { title: string } | null;
  groupLeave?: { ifLeaveFails: string } | null;
  activityPromise: { subject: string } | null;
  spotWatch: { label: string } | null;
  verdict: ReconcileVerdict;
}

export interface DispatchShadowInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
  claims: readonly StateClaim[];
}

/** The dispatch seam holds no database by design (dispatch.ts), so buildDispatchPorts
 * binds this port to its own handle. */
export interface DispatchClaimShadow {
  dispatch(input: DispatchShadowInput): ClaimShadowStart;
}

export interface ClaimShadow {
  coachTurn(
    database: Database,
    input: {
      familyId: string;
      parentUserId: string;
      now: Date;
      inbound: string;
      view: ReconcileView;
      attempts: readonly CoachShadowAttempt[];
    },
  ): ClaimShadowStart;
  sweep(
    database: Database,
    input: {
      lane: Exclude<ClaimShadowLane, 'coach' | 'dispatch'>;
      familyId: string;
      parentUserId: string | null;
      body: string;
      now: Date;
      verdict: ReconcileVerdict | null;
      view: ReconcileView | null;
    },
  ): ClaimShadowStart;
  dispatch(database: Database, input: DispatchShadowInput): ClaimShadowStart;
}

export interface ClaimShadowPorts {
  mode: () => ClaimReaderMode;
  reader: ClaimReader;
  /** (database, input): the handle always comes from the caller. */
  loadContext: typeof loadClaimShadowContext;
  capture: (
    event: AnalyticsEvent,
    distinctId: string,
    props: Record<string, unknown>,
  ) => Promise<CaptureOutcome>;
  /** Production: waitUntil. */
  detach: (task: Promise<void>) => void;
  log: Pick<Console, 'info' | 'error'>;
}

export type ShadowOutcome =
  | 'read'
  | ClaimReadFailure
  | Extract<ClaimShadowContext, { status: 'skipped' }>['reason'];

export type ShadowVerdict =
  | 'same'
  | 'reader_stricter'
  | 'regex_stricter'
  | 'both_refuse_differently'
  | 'not_compared';

type KindCounts = Record<ReadClaimKind, number>;
type ReasonCounts = Record<RefusalReason, number>;

const REFUSAL_REASONS = Object.keys({
  self_referential: true,
  no_registration_watch: true,
  spot_watch_unshaped: true,
  no_activity_promise: true,
  no_scheduled_row: true,
  no_coparent_invite: true,
  no_registration_record: true,
  no_send_record: true,
  no_delivery_record: true,
  no_cancel_record: true,
} satisfies Record<RefusalReason, true>) as RefusalReason[];

export interface ShadowComparison {
  mode: Exclude<ClaimReaderMode, 'off'>;
  lane: ClaimShadowLane;
  /** The primary language subtag, or `unknown`. */
  language: string;
  attempt: number;
  readerOutcome: ShadowOutcome | 'shadow_busy' | 'shadow_error';
  verdict: ShadowVerdict;
  readMs: number;
  readAttempts: number;
  readDeadline: boolean;
  usageIn: number;
  usageOut: number;
  segmentsN: number;
  candidatesCapped: number;
  pendingUncited: number;
  regexUnmapped: number;
  outsideReplyClaimsN: number;
  familyHash: string;
  regexN: KindCounts;
  readerN: KindCounts;
  agreeN: KindCounts;
  readerOnlyN: KindCounts;
  regexOnlyN: KindCounts;
  regexReason: ReasonCounts;
  readerReason: ReasonCounts;
  regexMints: number;
  readerMints: number;
}

const kinds = (): KindCounts =>
  Object.fromEntries(READ_CLAIM_KINDS.map((k) => [k, 0])) as KindCounts;
const reasons = (): ReasonCounts =>
  Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0])) as ReasonCounts;

/** Flat scalar keys only: buildEvent drops arrays, objects and identifying fragments. */
export function claimShadowProperties(
  c: ShadowComparison,
): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {
    mode: c.mode,
    lane: c.lane,
    language: c.language,
    attempt: c.attempt,
    reader_outcome: c.readerOutcome,
    verdict: c.verdict,
    read_ms: c.readMs,
    read_attempts: c.readAttempts,
    read_deadline: c.readDeadline,
    usage_in: c.usageIn,
    usage_out: c.usageOut,
    segments_n: c.segmentsN,
    candidates_capped: c.candidatesCapped,
    pending_uncited: c.pendingUncited,
    regex_unmapped: c.regexUnmapped,
    outside_reply_claims_n: c.outsideReplyClaimsN,
    family_hash: c.familyHash,
  };
  for (const k of READ_CLAIM_KINDS) {
    props[`regex_n_${k}`] = c.regexN[k];
    props[`reader_n_${k}`] = c.readerN[k];
    props[`agree_n_${k}`] = c.agreeN[k];
    props[`reader_only_n_${k}`] = c.readerOnlyN[k];
    props[`regex_only_n_${k}`] = c.regexOnlyN[k];
  }
  for (const r of REFUSAL_REASONS) {
    props[`regex_reason_${r}`] = c.regexReason[r];
    props[`reader_reason_${r}`] = c.readerReason[r];
  }
  props.regex_mints = c.regexMints;
  props.reader_mints = c.readerMints;
  return props;
}

/** Main has no spot kind: a watched page's sentence is a registration_watch there. */
const comparable = (kind: ReadClaimKind): ReadClaimKind =>
  kind === 'spot_watch' ? 'registration_watch' : kind;

function errName(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  return err.name !== 'Error' ? err.name : err.constructor.name;
}

function primaryLanguage(language: string | null): string {
  const locale = claimReadLocale(language);
  return locale === undefined ? 'unknown' : new Intl.Locale(locale).language;
}

function verdictFor(regex: ReadonlySet<number>, reader: ReadonlySet<number>): ShadowVerdict {
  const readerHasAll = [...regex].every((s) => reader.has(s));
  const regexHasAll = [...reader].every((s) => regex.has(s));
  if (readerHasAll && regexHasAll) return 'same';
  if (readerHasAll) return 'reader_stricter';
  if (regexHasAll) return 'regex_stricter';
  return 'both_refuse_differently';
}

/** One read: what to read, what the regex side decided about it, and how to load rows. */
interface Job {
  lane: ClaimShadowLane;
  attempt: number;
  familyId: string;
  body: string;
  /** Code units of the body in comparison scope: the coach's reply, else the whole body. */
  scopeEnd: number;
  side: RegexSide;
  inbound?: string;
  now: Date;
  load: () => Promise<ClaimShadowContext>;
}

function emptyComparison(job: Job, mode: Exclude<ClaimReaderMode, 'off'>): ShadowComparison {
  return {
    mode,
    lane: job.lane,
    language: 'unknown',
    attempt: job.attempt,
    readerOutcome: 'shadow_error',
    verdict: 'not_compared',
    readMs: 0,
    readAttempts: 0,
    readDeadline: false,
    usageIn: 0,
    usageOut: 0,
    segmentsN: 0,
    candidatesCapped: 0,
    pendingUncited: 0,
    regexUnmapped: 0,
    outsideReplyClaimsN: 0,
    familyHash: hashFamilyId(job.familyId),
    regexN: kinds(),
    readerN: kinds(),
    agreeN: kinds(),
    readerOnlyN: kinds(),
    regexOnlyN: kinds(),
    regexReason: reasons(),
    readerReason: reasons(),
    regexMints: 0,
    readerMints: 0,
  };
}

/** The regex half, which needs no read: counts by kind and reason, and its mints. */
function regexComparison(
  job: Job,
  mode: Exclude<ClaimReaderMode, 'off'>,
  judgements: readonly RegexJudgement[],
): ShadowComparison {
  const c = emptyComparison(job, mode);
  for (const j of judgements) {
    c.regexN[j.kind] += 1;
    if (j.decision !== 'sendable' && j.decision !== 'unrecorded_promise') {
      c.regexReason[j.decision] += 1;
    }
  }
  c.regexMints = job.side.kind === 'verdict' ? (job.side.verdict?.mints.length ?? 0) : 0;
  return c;
}

/** Each regex claim's segments, found by its sentence from a forward cursor. */
function mapRegex(
  body: string,
  segments: Extract<ClaimReadOutcome, { status: 'read' }>['segments'],
  judgements: readonly RegexJudgement[],
) {
  const mapped: Array<{ judgement: RegexJudgement; segments: ReadonlySet<number> }> = [];
  let unmapped = 0;
  let cursor = 0;
  for (const judgement of judgements) {
    const at = judgement.sentence === '' ? -1 : body.indexOf(judgement.sentence, cursor);
    if (at < 0) {
      unmapped += 1;
      continue;
    }
    const end = at + judgement.sentence.length;
    cursor = end;
    mapped.push({
      judgement,
      segments: new Set(segments.filter((s) => s.start < end && at < s.end).map((s) => s.index)),
    });
  }
  return { mapped, unmapped };
}

export function createClaimShadow(ports: ClaimShadowPorts): ClaimShadow {
  let inFlight = 0;

  async function run(job: Job, mode: Exclude<ClaimReaderMode, 'off'>): Promise<ShadowComparison> {
    const judgements = regexJudgements(job.side, job.lane);
    const c = regexComparison(job, mode, judgements);
    const context = await job.load();
    if (context.status === 'skipped') return { ...c, readerOutcome: context.reason };
    const candidates = buildClaimCandidates(job.familyId, context.rows, context.timeZone);
    c.language = primaryLanguage(context.language);
    c.candidatesCapped = candidates.capped.reduce((sum, cap) => sum + cap.dropped, 0);
    const outcome = await ports.reader.read({
      body: job.body,
      language: context.language,
      timeZone: context.timeZone,
      now: job.now,
      ...(job.inbound !== undefined ? { inbound: job.inbound } : {}),
      candidates,
      // Never the caller's: a turn deadline must not cut a post-send read.
      signal: new AbortController().signal,
      budgetMs: CLAIM_READ_MAX_BUDGET_MS,
    });
    c.readMs = outcome.latencyMs;
    c.readAttempts = outcome.attempts;
    if (outcome.status === 'failed') {
      return { ...c, readerOutcome: outcome.reason, readDeadline: outcome.deadline };
    }
    c.readerOutcome = 'read';
    c.usageIn = outcome.usage.input;
    c.usageOut = outcome.usage.output;
    c.segmentsN = outcome.segments.length;
    const read = verifyClaimRead(outcome, {
      candidates,
      locale: claimReadLocale(context.language),
      timeZone: context.timeZone,
    });
    const inScope = (segment: number) =>
      (outcome.segments[segment]?.start ?? Number.POSITIVE_INFINITY) < job.scopeEnd;
    const { mapped, unmapped } = mapRegex(job.body, outcome.segments, judgements);
    c.regexUnmapped = unmapped;

    const readerUnsendable = new Set<number>();
    const scoped = read.resolutions.filter((r) => {
      if (inScope(r.claim.segment)) return true;
      c.outsideReplyClaimsN += 1;
      return false;
    });
    for (const resolution of scoped) {
      const { kind, segment } = resolution.claim;
      c.readerN[kind] += 1;
      const agrees = mapped.some(
        (m) => m.segments.has(segment) && comparable(m.judgement.kind) === comparable(kind),
      );
      if (agrees) c.agreeN[kind] += 1;
      else c.readerOnlyN[kind] += 1;
      if (resolution.status === 'refused') {
        c.readerReason[resolution.reason] += 1;
        readerUnsendable.add(segment);
      } else if (resolution.status === 'minted') {
        c.readerMints += 1;
        // Only the coach writes the row against the message it sends.
        if (job.lane !== 'coach') readerUnsendable.add(segment);
      }
    }
    const regexUnsendable = new Set<number>();
    for (const m of mapped) {
      const seen = scoped.some(
        (r) =>
          m.segments.has(r.claim.segment) &&
          comparable(r.claim.kind) === comparable(m.judgement.kind),
      );
      if (!seen) c.regexOnlyN[m.judgement.kind] += 1;
      if (m.judgement.decision !== 'sendable') {
        for (const s of m.segments) regexUnsendable.add(s);
      }
    }
    c.verdict = verdictFor(regexUnsendable, readerUnsendable);
    const cited = new Set(outcome.claims.map((claim) => claim.row));
    c.pendingUncited = (['p1', 'p2'] as const).filter(
      (alias) => candidates.byAlias.has(alias) && !cited.has(alias),
    ).length;
    return c;
  }

  async function emit(c: ShadowComparison): Promise<void> {
    const props = claimShadowProperties(c);
    try {
      await ports.capture('agent_claim_shadow', c.familyHash, props);
    } catch (err) {
      ports.log.error(
        { event: 'claim_shadow_capture_failed', lane: c.lane, err: errName(err) },
        'claim shadow: capture failed',
      );
    }
    ports.log.info(
      { event: 'claim_shadow', lane: c.lane, reader_outcome: c.readerOutcome, verdict: c.verdict },
      'claim shadow: read compared',
    );
  }

  function begin(job: Job, mode: Exclude<ClaimReaderMode, 'off'>): ClaimShadowStart {
    if (inFlight >= CLAIM_SHADOW_MAX_IN_FLIGHT) {
      ports.detach(
        (async () => {
          let c: ShadowComparison;
          try {
            c = regexComparison(job, mode, regexJudgements(job.side, job.lane));
          } catch {
            c = emptyComparison(job, mode);
          }
          await emit({ ...c, readerOutcome: 'shadow_busy' });
        })(),
      );
      return 'busy';
    }
    inFlight += 1;
    ports.detach(
      (async () => {
        let c: ShadowComparison;
        try {
          c = await run(job, mode);
        } catch (err) {
          ports.log.error(
            { event: 'claim_shadow_failed', lane: job.lane, err: errName(err) },
            'claim shadow: the shadow task failed',
          );
          c = emptyComparison(job, mode);
        } finally {
          inFlight -= 1;
        }
        await emit(c);
      })(),
    );
    return 'started';
  }

  /** Read the flag on every call: `off` costs nothing at all. */
  function armed(): Exclude<ClaimReaderMode, 'off'> | null {
    const mode = ports.mode();
    return mode === 'off' ? null : mode;
  }

  return {
    coachTurn(database, input) {
      const mode = armed();
      if (!mode) return 'off';
      const starts = input.attempts.map((attempt, i) => {
        const reply = attempt.reply.trim() === '' ? '' : attempt.reply;
        // A newline always splits, so the card title and the leave line are their own
        // segments, after the reply's.
        const body = [reply, attempt.experienceCard?.title, attempt.groupLeave?.ifLeaveFails]
          .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
          .join('\n\n');
        return begin(
          {
            lane: 'coach',
            attempt: i + 1,
            familyId: input.familyId,
            body,
            scopeEnd: reply.length,
            side: { kind: 'verdict', verdict: attempt.verdict },
            inbound: input.inbound,
            now: input.now,
            load: () =>
              ports.loadContext(database, {
                familyId: input.familyId,
                now: input.now,
                parentUserId: input.parentUserId,
                view: input.view,
                pending: {
                  activityFollowup: attempt.activityPromise?.subject ?? null,
                  spotWatch: attempt.spotWatch?.label ?? null,
                },
              }),
          },
          mode,
        );
      });
      return starts.includes('busy') && !starts.includes('started') ? 'busy' : 'started';
    },
    sweep(database, input) {
      const mode = armed();
      if (!mode) return 'off';
      return begin(
        {
          lane: input.lane,
          attempt: 1,
          familyId: input.familyId,
          body: input.body,
          scopeEnd: input.body.length,
          side: { kind: 'verdict', verdict: input.verdict },
          now: input.now,
          load: () =>
            ports.loadContext(database, {
              familyId: input.familyId,
              now: input.now,
              parentUserId: input.parentUserId,
              ...(input.view ? { view: input.view } : {}),
            }),
        },
        mode,
      );
    },
    dispatch(database, input) {
      const mode = armed();
      if (!mode) return 'off';
      return begin(
        {
          lane: 'dispatch',
          attempt: 1,
          familyId: input.familyId,
          body: input.body,
          scopeEnd: input.body.length,
          side: { kind: 'no_ledger', claims: input.claims },
          now: input.now,
          load: () =>
            ports.loadContext(database, {
              familyId: input.familyId,
              now: input.now,
              parentUserId: input.parentUserId,
            }),
        },
        mode,
      );
    },
  };
}

/** Function references only: nothing here opens a connection or reads a required env,
 * because refuseUnbackedSend evaluates the default shadow on every regex decision. */
export function defaultClaimShadowPorts(): ClaimShadowPorts {
  return {
    mode: claimReaderMode,
    reader: defaultClaimReader('adaptive'),
    loadContext: loadClaimShadowContext,
    capture: captureServerEvent,
    detach: waitUntil,
    log: console,
  };
}

let shared: ClaimShadow | undefined;

/** One per process, so the in-flight bound is process-wide. */
export function defaultClaimShadow(): ClaimShadow {
  shared ??= createClaimShadow(defaultClaimShadowPorts());
  return shared;
}
