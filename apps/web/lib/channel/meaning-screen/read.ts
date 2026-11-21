import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { acceptReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, pipelineClient } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * One Haiku screen for leftover word-list / regex intent checks.
 *
 * A missing client, a missing skill, or a model failure is unread (null).
 * Callers fail closed: send nothing, take no action. The parent's text is
 * never in the log line.
 */

export const MEANING_SCREENS = [
  'copy_friend',
  'copy_false_promise',
  'copy_reply_banned',
  'copy_keyword_instruction',
  'stated_state',
  'provider_access',
  'activity_decision',
  'health_done',
  'registration_outcome',
  'connect_intent',
  'duty_undo',
  'duty_stop_asking',
  'both_free',
  'memory_request',
  'memory_target',
] as const;

export type MeaningScreenName = (typeof MEANING_SCREENS)[number];

export const COPY_FRIEND_VIOLATIONS = [
  'privacy',
  'banned',
  'compliance',
  'registration',
  'invented',
] as const;
export type CopyFriendViolation = (typeof COPY_FRIEND_VIOLATIONS)[number];

export const COPY_FALSE_PROMISE_VIOLATIONS = [
  'promised_a_retry',
  'promised_a_time',
  'points_at_the_app',
] as const;
export type CopyFalsePromiseViolation = (typeof COPY_FALSE_PROMISE_VIOLATIONS)[number];

export type ProviderAccessKind = 'eye' | 'primary' | 'none';
export type ActivityDecisionKind = 'picked' | 'passed' | 'none';
export type HealthDoneIntent = 'done' | 'booking' | 'none';
export type RegistrationOutcomeKind = 'registered' | 'waitlisted' | 'missed' | 'none';
export type ConnectAction = 'connect' | 'disconnect' | 'fresh_link' | 'none';
export type ConnectProvider = 'gcal' | 'gmail' | 'gdrive' | 'none';
export type DutyUndoKind = 'clear' | 'reassign' | 'none';
export const MEMORY_REQUEST_KINDS = ['list', 'forget', 'correct', 'none'] as const;
/** What a parent asked of what Hale remembers about the family (VIL-723). */
export type MemoryRequestKind = (typeof MEMORY_REQUEST_KINDS)[number];

/** A `memory_target` fact ref is `f` and its 1-based place in `facts`. A shape, not a meaning. */
const FACT_REF = /^f[1-9][0-9]{0,2}$/;
const MAX_REFS = 40;

export interface MeaningScreenInput {
  screen: MeaningScreenName;
  text: string;
  facts?: readonly string[];
}

export interface MeaningScreenReading {
  hit: boolean;
  violations: string[];
  kind: string;
  intent: string;
  outcome: string;
  decision: ActivityDecisionKind;
  action: ConnectAction;
  provider: ConnectProvider;
  activity: string;
  kid: string;
  day: string;
  time: string;
  name: string;
  position: number | null;
  /** `memory_request`: list, forget, correct, or none. */
  memory: MemoryRequestKind;
  /** `memory_request`: the parent's own words for what to forget or correct. Empty when none. */
  target: string;
  /** `memory_request` / `memory_target`: the corrected value, as the parent said it. */
  value: string;
  /** `memory_target`: a short snake_case label for a corrected fact nothing on file holds. */
  key: string;
  /** `memory_request`: the BCP-47 tag of the language the text is written in, or null. */
  language: string | null;
  /** `memory_target`: refs (`f1`, `f2`, ...) into `facts`. Only refs, deduplicated. */
  refs: string[];
}

export interface MeaningScreen {
  /** Null: the read failed. Callers take no action. */
  read(input: MeaningScreenInput): Promise<MeaningScreenReading | null>;
}

export const MEANING_SCREEN_TOOL = 'meaning_screen';
export const MEANING_SCREEN_DESCRIPTION =
  'Return what this text means for the named screen. Do not write a parent reply.';
export const MEANING_SCREEN_MAX_TOKENS = 256;
export const MEANING_SCREEN_SKILL = 'meaning-screen';

const MAX_TEXT_CHARS = 1600;

export const MEANING_SCREEN_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    hit: { type: 'string', enum: ['yes', 'no'] },
    violations: {
      type: 'array',
      items: { type: 'string' },
    },
    kind: { type: 'string' },
    intent: { type: 'string' },
    outcome: { type: 'string' },
    decision: { type: 'string' },
    action: { type: 'string' },
    provider: { type: 'string' },
    activity: { type: 'string' },
    kid: { type: 'string' },
    day: { type: 'string' },
    time: { type: 'string' },
    name: { type: 'string' },
    position: { type: ['integer', 'null'] },
    memory: { type: 'string', enum: [...MEMORY_REQUEST_KINDS] },
    target: { type: 'string' },
    value: { type: 'string' },
    key: { type: 'string' },
    language: { type: 'string' },
    refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['reason', 'hit'],
};

const rawSchema = z.object({
  reason: z.string(),
  hit: z.enum(['yes', 'no']),
  violations: z.array(z.string()).optional(),
  kind: z.string().optional(),
  intent: z.string().optional(),
  outcome: z.string().optional(),
  decision: z.string().optional(),
  action: z.string().optional(),
  provider: z.string().optional(),
  activity: z.string().optional(),
  kid: z.string().optional(),
  day: z.string().optional(),
  time: z.string().optional(),
  name: z.string().optional(),
  position: z.number().nullable().optional(),
  memory: z.string().optional(),
  target: z.string().optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  language: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

/** The user-turn payload. Shared with the eval, which replays this request. */
export function meaningScreenUserMessage(input: MeaningScreenInput): string {
  return JSON.stringify({
    screen: input.screen,
    text: input.text.slice(0, MAX_TEXT_CHARS),
    ...(input.facts ? { facts: input.facts } : {}),
  });
}

/**
 * The request the screen sends. Loading it does not call a model. The eval's
 * dry run prices this shape; a live run replays it.
 */
export async function meaningScreenRequest(input: MeaningScreenInput) {
  const skill = await loadCronSkill(MEANING_SCREEN_SKILL);
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: meaningScreenUserMessage(input),
    toolName: MEANING_SCREEN_TOOL,
    toolDescription: MEANING_SCREEN_DESCRIPTION,
    toolSchema: MEANING_SCREEN_SCHEMA,
    maxTokens: MEANING_SCREEN_MAX_TOKENS,
  };
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function toMeaningReading(
  raw: z.infer<typeof rawSchema>,
  screen: MeaningScreenName,
): MeaningScreenReading {
  const hit = raw.hit === 'yes';
  const violations = (raw.violations ?? []).filter((code) => {
    if (screen === 'copy_friend') {
      return (COPY_FRIEND_VIOLATIONS as readonly string[]).includes(code);
    }
    if (screen === 'copy_false_promise') {
      return (COPY_FALSE_PROMISE_VIOLATIONS as readonly string[]).includes(code);
    }
    return false;
  });
  const position =
    typeof raw.position === 'number' &&
    Number.isInteger(raw.position) &&
    raw.position > 0 &&
    raw.position <= 9999
      ? raw.position
      : null;
  return {
    hit,
    violations,
    kind: oneOf(raw.kind, ['eye', 'primary', 'none'] as const, 'none'),
    intent: oneOf(raw.intent, ['done', 'booking', 'none'] as const, 'none'),
    outcome: oneOf(raw.outcome, ['registered', 'waitlisted', 'missed', 'none'] as const, 'none'),
    decision: oneOf(raw.decision, ['picked', 'passed', 'none'] as const, 'none'),
    action: oneOf(raw.action, ['connect', 'disconnect', 'fresh_link', 'none'] as const, 'none'),
    provider: oneOf(raw.provider, ['gcal', 'gmail', 'gdrive', 'none'] as const, 'none'),
    activity: (raw.activity ?? '').trim(),
    kid: (raw.kid ?? '').trim(),
    day: (raw.day ?? '').trim(),
    time: (raw.time ?? '').trim(),
    name: (raw.name ?? '').trim(),
    position,
    memory: screen === 'memory_request' ? oneOf(raw.memory, MEMORY_REQUEST_KINDS, 'none') : 'none',
    target: screen === 'memory_request' ? (raw.target ?? '').trim() : '',
    value:
      screen === 'memory_request' || screen === 'memory_target' ? (raw.value ?? '').trim() : '',
    key: screen === 'memory_target' ? memoryKeyShape(raw.key) : '',
    language: screen === 'memory_request' ? acceptReplyLanguage(raw.language) : null,
    refs: screen === 'memory_target' ? factRefs(raw.refs) : [],
  };
}

/** The refs a `memory_target` read named, kept only when they are ref-shaped. */
function factRefs(raw: readonly string[] | undefined): string[] {
  const kept: string[] = [];
  for (const ref of raw ?? []) {
    const trimmed = ref.trim().toLowerCase();
    if (FACT_REF.test(trimmed) && !kept.includes(trimmed)) kept.push(trimmed);
    if (kept.length >= MAX_REFS) break;
  }
  return kept;
}

/** A fact key the model proposed: lowercase snake_case, or nothing. A shape, not a meaning. */
function memoryKeyShape(raw: string | undefined): string {
  const key = (raw ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,59}$/.test(key) ? key : '';
}

function unread(reason: string): null {
  console.info({ reason }, 'meaning screen: unread');
  return null;
}

export function createMeaningScreen(client: () => AgentClient): MeaningScreen {
  return {
    async read(input) {
      const bounded: MeaningScreenInput = {
        ...input,
        text: input.text.slice(0, MAX_TEXT_CHARS),
      };
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        return unread('client_unavailable');
      }

      let request: Awaited<ReturnType<typeof meaningScreenRequest>>;
      try {
        request = await meaningScreenRequest(bounded);
      } catch {
        return unread('skill_unavailable');
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: request.lane,
          system: request.system,
          userMessage: request.userMessage,
          toolName: request.toolName,
          toolDescription: request.toolDescription,
          inputJsonSchema: request.toolSchema,
          schema: rawSchema,
          maxTokens: request.maxTokens,
        });
        return toMeaningReading(value, bounded.screen);
      } catch {
        return unread('model_failed');
      }
    },
  };
}

let shared: MeaningScreen | null = null;

export function setSharedMeaningScreen(screen: MeaningScreen | null): void {
  shared = screen;
}

/** Production default: the pipeline client. Tests inject via {@link setSharedMeaningScreen}. */
export function sharedMeaningScreen(): MeaningScreen {
  return shared ?? createMeaningScreen(() => pipelineClient());
}

/** A resolver that constructs the hot-path client. Tests that need a throw inject instead. */
export function defaultMeaningScreenClient(): AgentClient {
  return pipelineClient();
}

/** Budget the inbound screen shares with other SMS reads. Exported for the eval. */
export const MEANING_SCREEN_CLIENT_OPTIONS = HOT_SMS_CLIENT_OPTIONS;
