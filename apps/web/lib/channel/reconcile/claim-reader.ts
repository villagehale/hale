import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type LaneConfig, pickLane, withoutThinking } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type IncidentFailure,
  classifyChainedProviderFailure,
} from '~/lib/monitoring/provider-health';
import { CLAIM_READ_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import { CLAIM_ROW_ALIASES, type ClaimCandidateSet, type ClaimRowAlias } from './candidates';
import { type Segment, claimReadLocale, segmentSentences } from './sentences';

/**
 * VIL-581 · a model reads what each sentence Hale is about to send claims, in any
 * language, and cites the one row each claim is about.
 *
 * The model reads the meaning. Code owns the sentence boundaries (sentences.ts), the
 * citation namespace (a static alias enum and a per-call map, candidates.ts) and kind
 * compatibility (claim-verdict.ts). The answer is indices, kinds and aliases from fixed
 * enums: the model cannot put text into it.
 *
 * In SHADOW (PR 2) the parent-path caller is claim-shadow.ts, which reads after or
 * beside the regex gate's decision and never changes it. The warm/probe route and the
 * claim-read eval are its other callers.
 *
 * Every read ends in a typed outcome (rule #11): a read, or a NAMED failure. A failure
 * is never a refused claim, and never null.
 */

export const READ_CLAIM_KINDS = [
  'scheduled_event',
  'registration_watch',
  'spot_watch',
  'activity_followup',
  'co_parent_invite',
  'self_referential',
  'registration_done',
  'send_done',
  'cancelled',
] as const;
export type ReadClaimKind = (typeof READ_CLAIM_KINDS)[number];

export const CLAIM_READ_SKILL = 'claim-read';
export const CLAIM_READ_TOOL_NAME = 'claim_read';
export const CLAIM_READ_TOOL_DESCRIPTION =
  'Return each claim the numbered sentences make and the row it is about.';
/** The text-check.ts precedent for a short structured verdict. */
export const CLAIM_READ_MAX_TOKENS = 2048;
/** One whole read, every send included. */
export const CLAIM_READ_MAX_BUDGET_MS = 15_000;
/** Provisional: the recorded p95 sets it before anything enforces (PR 3). */
export const CLAIM_READ_MIN_BUDGET_MS = 5_000;
/** Code points. A longer body is not read at all: a cut body would fail open. */
export const CLAIM_READ_MAX_BODY_CHARS = 8_000;
/** Code points. Inbound is context only, so a longer one is cut. */
export const CLAIM_READ_MAX_INBOUND_CHARS = 2_000;

/**
 * Structure frozen: the output grammar is keyed on it, so one schema serves every call.
 * `reason` is required and first (the house rule: reason before verdict). Code never
 * reads it, logs it or sends it.
 */
export const CLAIM_READ_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'claims'],
  properties: {
    reason: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sentence', 'kind', 'row'],
        properties: {
          sentence: { type: 'integer' },
          kind: { type: 'string', enum: [...READ_CLAIM_KINDS] },
          row: { type: 'string', enum: [...CLAIM_ROW_ALIASES] },
        },
      },
    },
  },
} as const;

const outputSchema = z.object({
  reason: z.string(),
  claims: z.array(
    z.object({
      sentence: z.number().int(),
      kind: z.enum(READ_CLAIM_KINDS),
      row: z.enum(CLAIM_ROW_ALIASES as unknown as [ClaimRowAlias, ...ClaimRowAlias[]]),
    }),
  ),
});

export interface ClaimReadInput {
  body: string;
  language: ReplyLanguage | null;
  timeZone: string;
  now: Date;
  /** Coach turns only: the parent's message this one answers. Data, never an instruction. */
  inbound?: string;
  candidates: ClaimCandidateSet;
  /** The caller's own deadline (the turn or the sweep). */
  signal: AbortSignal;
  /** The time the caller can give this read. */
  budgetMs: number;
}

export interface ReadClaim {
  segment: number;
  kind: ReadClaimKind;
  row: ClaimRowAlias;
}

export type ClaimReadFailure =
  | 'unreachable'
  | 'rate_limited'
  | 'incident'
  | 'no_budget'
  | 'truncated'
  | 'refused'
  | 'unparseable'
  /** thinking 'off' on a lane with no thinking-off form: no call was made. */
  | 'lane_unavailable'
  /** The body is over CLAIM_READ_MAX_BODY_CHARS: no call was made. */
  | 'oversize'
  /** A provider 4xx none of the shapes above names (a non-billing 400, a 404, a 422). */
  | 'provider_rejected';

export type ClaimReadOutcome =
  | {
      status: 'read';
      segments: readonly Segment[];
      claims: readonly ReadClaim[];
      usage: { input: number; output: number };
      latencyMs: number;
      attempts: 1 | 2;
    }
  | {
      status: 'failed';
      reason: ClaimReadFailure;
      incident?: IncidentFailure;
      attempts: 0 | 1 | 2;
      latencyMs: number;
      /** True when the reader's OWN timer, not the caller's signal, aborted the call. */
      deadline: boolean;
    };

export interface ClaimReader {
  read(input: ClaimReadInput): Promise<ClaimReadOutcome>;
}

export interface ClaimReaderDeps {
  client: AgentClient | (() => AgentClient);
  /** Waits out a rate limit's retry-after; rejects when the signal aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Milliseconds, for the budget check before each retry. */
  clock: () => number;
  /** 'off' runs the skill's lane with as little thinking as the tier allows. */
  thinking: 'adaptive' | 'off';
  /** The read's own deadline signal. Production: AbortSignal.timeout. */
  timer: (ms: number) => AbortSignal;
}

/** `now` as the family's local ISO time with its offset: `2026-11-03T03:00-07:00`. */
export function claimReadNow(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`claimReadNow: no ${type} part`);
    return value;
  };
  const zone = part('timeZoneName');
  const offset = zone === 'GMT' ? '+00:00' : zone.replace('GMT', '');
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}${offset}`;
}

/** The user payload: data only. The instructions live in the claim-read skill. Shared
 * with the eval, so a recording is the production request. */
export function claimReadUserMessage(input: {
  languageHint: string | null;
  now: string;
  inbound?: string;
  segments: readonly Segment[];
  candidates: ClaimCandidateSet;
}): string {
  return JSON.stringify({
    languageHint: input.languageHint,
    now: input.now,
    ...(input.inbound !== undefined
      ? { inbound: [...input.inbound].slice(0, CLAIM_READ_MAX_INBOUND_CHARS).join('') }
      : {}),
    sentences: input.segments.map((s) => ({ i: s.index, text: s.text })),
    rows: input.candidates.projected,
  });
}

/** Shape, index range and de-duplication. Anything else is not a read. */
export function acceptClaimRead(
  value: unknown,
  segmentCount: number,
): { ok: true; claims: ReadClaim[] } | { ok: false } {
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const claims: ReadClaim[] = [];
  const seen = new Set<string>();
  for (const c of parsed.data.claims) {
    if (c.sentence < 0 || c.sentence >= segmentCount) return { ok: false };
    const key = `${c.sentence}|${c.kind}|${c.row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ segment: c.sentence, kind: c.kind, row: c.row });
  }
  return { ok: true, claims };
}

interface AttemptFailure {
  reason: ClaimReadFailure;
  incident?: IncidentFailure;
  retryAfterMs: number;
  err: string;
  deadline: boolean;
}

function errName(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  return err.name !== 'Error' ? err.name : err.constructor.name;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

function retryAfterMs(err: unknown): number {
  const header = (err as { headers?: Record<string, string | null | undefined> }).headers?.[
    'retry-after'
  ];
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * The reader maps errors itself, never through classifyTurnFailure: our own deadline
 * abort is not a transport error there. A provider error none of these shapes names is
 * `provider_rejected`, logged by its class only. Any other error is a bug and is thrown,
 * not folded into an outcome.
 */
function classify(err: unknown, callerSignal: AbortSignal, timer: AbortSignal): AttemptFailure {
  const named = (reason: ClaimReadFailure, extra: Partial<AttemptFailure> = {}) => ({
    reason,
    retryAfterMs: 0,
    err: errName(err),
    deadline: false,
    ...extra,
  });
  const incident = classifyChainedProviderFailure(err);
  if (incident) return named('incident', { incident });
  if (isAbort(err)) {
    if (callerSignal.aborted) return named('no_budget');
    return named('unreachable', { deadline: timer.aborted });
  }
  if (err instanceof Anthropic.APIConnectionError) return named('unreachable');
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 500) return named('unreachable');
  if (err instanceof Anthropic.RateLimitError) {
    return named('rate_limited', { retryAfterMs: retryAfterMs(err) });
  }
  if (err instanceof StructuredOutputError) {
    if (err.outcome === 'truncated') return named('truncated');
    if (err.outcome === 'refusal') return named('refused');
    return named('unparseable');
  }
  if (err instanceof z.ZodError) return named('unparseable');
  if (err instanceof Anthropic.APIError) return named('provider_rejected');
  throw err;
}

const RETRYABLE: ReadonlySet<ClaimReadFailure> = new Set([
  'unreachable',
  'unparseable',
  'rate_limited',
]);

export function createClaimReader(deps: ClaimReaderDeps): ClaimReader {
  const resolveClient = () => (typeof deps.client === 'function' ? deps.client() : deps.client);

  return {
    async read(input) {
      const start = deps.clock();
      const failed = (
        failure: Pick<AttemptFailure, 'reason' | 'incident' | 'err'> &
          Partial<Pick<AttemptFailure, 'deadline'>>,
        attempts: 0 | 1 | 2,
      ): ClaimReadOutcome => {
        console.error(
          {
            event: 'claim_read_failed',
            reason: failure.reason,
            ...(failure.incident ? { incident: failure.incident } : {}),
            attempts,
            err: failure.err,
          },
          'claim reader: read failed',
        );
        return {
          status: 'failed',
          reason: failure.reason,
          ...(failure.incident ? { incident: failure.incident } : {}),
          attempts,
          latencyMs: deps.clock() - start,
          deadline: failure.deadline ?? false,
        };
      };

      if ([...input.body].length > CLAIM_READ_MAX_BODY_CHARS) {
        return failed({ reason: 'oversize', err: 'none' }, 0);
      }
      if (input.budgetMs < CLAIM_READ_MIN_BUDGET_MS || input.signal.aborted) {
        return failed({ reason: 'no_budget', err: 'none' }, 0);
      }
      const deadline = start + Math.min(input.budgetMs, CLAIM_READ_MAX_BUDGET_MS);
      const timer = deps.timer(deadline - start);
      const signal = AbortSignal.any([input.signal, timer]);

      const skill = await loadCronSkill(CLAIM_READ_SKILL);
      const skillLane = pickLane(skill.meta.task);
      const lane: LaneConfig | null =
        deps.thinking === 'off' ? withoutThinking(skillLane) : skillLane;
      if (!lane) return failed({ reason: 'lane_unavailable', err: 'none' }, 0);

      const locale = claimReadLocale(input.language);
      const segments = segmentSentences(input.body, locale);
      const userMessage = claimReadUserMessage({
        languageHint: certainLanguageHint(input.language),
        now: claimReadNow(input.now, input.timeZone),
        ...(input.inbound !== undefined ? { inbound: input.inbound } : {}),
        segments,
        candidates: input.candidates,
      });

      let first: AttemptFailure | undefined;
      for (const attempt of [1, 2] as const) {
        let failure: AttemptFailure;
        try {
          const { value, usage } = await forceToolJson({
            client: resolveClient(),
            lane,
            system: skill.instructions,
            userMessage,
            toolName: CLAIM_READ_TOOL_NAME,
            toolDescription: CLAIM_READ_TOOL_DESCRIPTION,
            inputJsonSchema: CLAIM_READ_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            schema: outputSchema,
            maxTokens: CLAIM_READ_MAX_TOKENS,
            signal,
          });
          const accepted = acceptClaimRead(value, segments.length);
          if (accepted.ok) {
            return {
              status: 'read',
              segments,
              claims: accepted.claims,
              usage: { input: usage.input_tokens, output: usage.output_tokens },
              latencyMs: deps.clock() - start,
              attempts: attempt,
            };
          }
          failure = {
            reason: 'unparseable',
            retryAfterMs: 0,
            err: 'ClaimReadInvalid',
            deadline: false,
          };
        } catch (err) {
          failure = classify(err, input.signal, timer);
        }
        if (attempt === 2 || !RETRYABLE.has(failure.reason)) return failed(failure, attempt);
        first = failure;
        // Before every retry: a retry that cannot get the floor is not made, and the
        // outcome stays the first attempt's own reason, never our abort of a starved call.
        if (deadline - deps.clock() - failure.retryAfterMs < CLAIM_READ_MIN_BUDGET_MS) {
          return failed(first, 1);
        }
        if (failure.retryAfterMs > 0) {
          try {
            await deps.wait(failure.retryAfterMs, signal);
          } catch {
            return failed(first, 1);
          }
        }
      }
      throw new Error('claim reader: unreachable retry loop exit');
    },
  };
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The production reader: the direct Anthropic client (never the AI Gateway: candidate
 * rows can be Google-derived), a timer wait, the wall clock, the skill's own lane. */
export function defaultClaimReader(thinking: 'adaptive' | 'off' = 'adaptive'): ClaimReader {
  let client: AgentClient | undefined;
  return createClaimReader({
    client: () => {
      client ??= budgetedAnthropic(CLAIM_READ_CLIENT_OPTIONS, { stage: 'claim_read' });
      return client;
    },
    wait: abortableWait,
    clock: Date.now,
    thinking,
    timer: (ms) => AbortSignal.timeout(ms),
  });
}
