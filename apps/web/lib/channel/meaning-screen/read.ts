import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
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
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
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
    typeof raw.position === 'number' && Number.isInteger(raw.position) && raw.position > 0 && raw.position <= 9999
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
  };
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
