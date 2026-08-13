import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { findInventedFacts } from './facts-lint';

/**
 * VIL-249 — the two composed surfaces of the calendar invite: the ONE text that asks a
 * texting family for an email address, and the subject + note that carry the invite
 * itself.
 *
 * NO PRESET BODIES (founder, 2026-08-12, absolute). Hale does not keep a canned
 * sentence for either of these, so there is deliberately no deterministic fallback
 * copy here — which is a departure from the VIL-229 voice contract in
 * lib/channel/types.ts, where every voiced slot keeps one and a send is never blocked
 * on the model. The trade that replaces it: gates the model must clear, up to three
 * attempts with the violation NAMED back to it, and then a DEFER — no send at all,
 * named to the caller, with the ask's once-ever claim left unconsumed so the next
 * placement tries again. Nothing ever goes out unreviewed, and nothing goes out
 * pretending a preset was a composed line.
 *
 * PRIVACY (rule #1). The ask is composed BLIND — the model is handed nothing, because
 * a standing offer needs nothing. The note is handed ONLY the already-redacted
 * descriptor the recipient's own dial produced, plus the formatted time, and both must
 * come back VERBATIM (the containment gate). A composer given only the redacted string
 * cannot leak a fuller title than the dial allows, and the gate proves it did not
 * paraphrase its way around one either.
 */

/** One SMS segment. The ask is a standing offer, never worth two. */
export const MAX_ASK_CHARS = 160;
/** Room for two warm sentences carrying the summary and the time. */
export const MAX_NOTE_BODY_CHARS = 320;
export const MAX_NOTE_SUBJECT_CHARS = 120;

const ASK_MAX_TOKENS = 200;
const NOTE_MAX_TOKENS = 400;

/**
 * How many times the model may be told what it got wrong before Hale gives up on this
 * message. Three is the whole budget: one blind attempt, two with the violation named.
 * A fourth would be paying for the same failure again — the shapes these gates catch
 * (a link, a second question, an invented time) are not the kind a model fixes on the
 * fourth read when it ignored the third.
 */
export const MAX_COMPOSE_ATTEMPTS = 3;

const LINK_SHAPE = /https?:\/\/|www\./i;

export type ComposedAsk =
  | { status: 'composed'; text: string; attempts: number }
  | { status: 'deferred'; reason: string; attempts: number };

export type ComposedNote =
  | { status: 'composed'; subject: string; body: string; attempts: number }
  | { status: 'deferred'; reason: string; attempts: number };

/** What the note is written about: the event as THIS recipient may see it. */
export interface InviteNoteContext {
  /** The already-redacted descriptor — teen/sensitive events arrive generic. */
  summary: string;
  /** The start, formatted in the family's own timezone. */
  when: string;
  method: 'added' | 'cancelled';
}

export interface CalendarVoice {
  /** The standing ask for an address. Blind — no family, no event. */
  composeAsk(): Promise<ComposedAsk>;
  composeNote(context: InviteNoteContext): Promise<ComposedNote>;
}

const askSchema = z.object({ text: z.string() });
const noteSchema = z.object({ subject: z.string(), body: z.string() });

const askJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

const noteJsonSchema = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
} as const;

/** The user turn for the note. Shared with the eval, which REPLICATES this shape. */
export function inviteNoteUserMessage(context: InviteNoteContext): string {
  return JSON.stringify(context);
}

/** The ask is blind; the turn exists only because a request needs one. */
export const ASK_USER_MESSAGE = JSON.stringify({});

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/** Collapse the shapes a phone or a mail client would render badly, before gating. */
function tidy(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

// ── the gates ────────────────────────────────────────────────────────────────

/**
 * Every rule the ask must clear, as a list of named violations (empty = sendable).
 *
 * The names are handed BACK to the model on the retry, so each one has to read as an
 * instruction rather than an error code.
 */
export function askViolations(text: string): string[] {
  const out: string[] = [];
  if (text === '') out.push('the message was empty');
  if (text.length > MAX_ASK_CHARS) {
    out.push(`the message was ${text.length} characters; the limit is ${MAX_ASK_CHARS}`);
  }
  if (smsEncoding(text) !== 'gsm7') {
    out.push('the message used a character outside plain ASCII (a curly quote, a long dash or an emoji)');
  }
  // AT MOST one question mark. The first live run wrote the ask as an offer with an
  // instruction — "I can send real calendar invites by email - text me your address"
  // — three times out of three, and it is better copy than the interrogative it was
  // being forced into. What actually had to be stopped was the INTERROGATION ("Want
  // invites? What's your address?"), which is the second question mark, so that is
  // what the gate holds. "Does it actually ask" is the `email` check and the judge.
  const questionMarks = (text.match(/\?/g) ?? []).length;
  if (questionMarks > 1) {
    out.push(`the message asked ${questionMarks} questions; ask at most one thing`);
  }
  if (!/email/i.test(text)) out.push('the message never used the word "email", so it does not ask for one');
  if (LINK_SHAPE.test(text)) out.push('the message carried a link; there is nothing to link to');
  if (text.includes('@')) out.push('the message contained an @ address; an example address is invented');
  if (/\d/.test(text)) out.push('the message contained a digit; there is no number you could know here');
  return out;
}

/**
 * Every rule the note must clear. The first two are the CONTAINMENT gate: the redacted
 * summary and the formatted time must survive into the message unchanged, so the
 * composer can neither expand a genericized title nor quietly restate a time.
 */
export function noteViolations(note: { subject: string; body: string }, context: InviteNoteContext): string[] {
  const out: string[] = [];
  const { subject, body } = note;

  if (!subject.includes(context.summary)) {
    out.push(`the subject must contain "${context.summary}" exactly as given`);
  }
  if (!body.includes(context.summary)) {
    out.push(`the body must contain "${context.summary}" exactly as given`);
  }
  if (!body.includes(context.when)) {
    out.push(`the body must contain "${context.when}" exactly as given`);
  }
  if (subject === '') out.push('the subject was empty');
  if (body === '') out.push('the body was empty');
  if (subject.length > MAX_NOTE_SUBJECT_CHARS) {
    out.push(`the subject was ${subject.length} characters; the limit is ${MAX_NOTE_SUBJECT_CHARS}`);
  }
  if (body.length > MAX_NOTE_BODY_CHARS) {
    out.push(`the body was ${body.length} characters; the limit is ${MAX_NOTE_BODY_CHARS}`);
  }
  if (LINK_SHAPE.test(subject) || LINK_SHAPE.test(body)) {
    out.push('the message carried a link; the attachment is the whole action');
  }

  // The invented-fact lint, over the only two facts that exist for this message. A
  // clock time or URL absent from both is a specific the model made up.
  const slots = [context.summary, context.when];
  const invented = [...findInventedFacts(subject, slots), ...findInventedFacts(body, slots)];
  if (invented.length > 0) {
    out.push(`these were not in the event you were given: ${[...new Set(invented)].join(', ')}`);
  }
  return out;
}

/** The retry turn: the model's own attempt, and what was wrong with it. */
export function retryUserMessage(original: string, attempt: string, violations: string[]): string {
  return JSON.stringify({
    original: JSON.parse(original),
    yourLastAttempt: attempt,
    problems: violations,
    instruction: 'Write it again, fixing every problem listed. Same JSON shape.',
  });
}

// ── the production composer ──────────────────────────────────────────────────

/**
 * Both composers, over one lazily-resolved client — the resolver shape the general
 * answer uses, and for the same reason: these deps are built on paths that may never
 * reach a model, so a missing key must be a named outcome rather than a throw at
 * construction.
 */
export function createCalendarVoice(client: () => AgentClient): CalendarVoice {
  async function run<TValue>(args: {
    skillName: string;
    toolName: string;
    toolDescription: string;
    inputJsonSchema: Parameters<typeof forceToolJson>[0]['inputJsonSchema'];
    schema: z.ZodType<TValue>;
    userMessage: string;
    maxTokens: number;
    /** The named problems with an attempt, empty when it may be sent. */
    violations: (value: TValue) => string[];
    /** The attempt as the model would read it back, for the retry turn. */
    render: (value: TValue) => string;
    /** Whitespace-tidy the raw fields before gating. */
    tidyValue: (value: TValue) => TValue;
  }): Promise<{ status: 'composed'; value: TValue; attempts: number } | { status: 'deferred'; reason: string; attempts: number }> {
    let resolved: AgentClient;
    try {
      resolved = client();
    } catch (err) {
      return { status: 'deferred', reason: `client_unavailable: ${message(err)}`, attempts: 0 };
    }

    let skill: Awaited<ReturnType<typeof loadCronSkill>>;
    try {
      skill = await loadCronSkill(args.skillName);
    } catch (err) {
      return { status: 'deferred', reason: `skill_unavailable: ${message(err)}`, attempts: 0 };
    }

    let turn = args.userMessage;
    let lastProblem = 'no attempt was made';
    for (let attempt = 1; attempt <= MAX_COMPOSE_ATTEMPTS; attempt += 1) {
      let value: TValue;
      try {
        const result = await forceToolJson({
          client: resolved,
          model: pickModel(skill.meta.task),
          system: skill.instructions,
          userMessage: turn,
          toolName: args.toolName,
          toolDescription: args.toolDescription,
          inputJsonSchema: args.inputJsonSchema,
          schema: args.schema,
          maxTokens: args.maxTokens,
        });
        value = args.tidyValue(result.value as TValue);
      } catch (err) {
        // An outage or an unparseable answer is worth one more try inside the budget,
        // and is the named reason if it is the last one.
        lastProblem = `model_failed: ${message(err)}`;
        turn = args.userMessage;
        continue;
      }

      const violations = args.violations(value);
      if (violations.length === 0) return { status: 'composed', value, attempts: attempt };

      lastProblem = violations.join('; ');
      turn = retryUserMessage(args.userMessage, args.render(value), violations);
    }

    console.error(
      { skill: args.skillName, attempts: MAX_COMPOSE_ATTEMPTS, problem: lastProblem },
      'calendar voice: no sendable draft after the retry budget — deferring',
    );
    return { status: 'deferred', reason: lastProblem, attempts: MAX_COMPOSE_ATTEMPTS };
  }

  return {
    async composeAsk() {
      const result = await run<{ text: string }>({
        skillName: 'calendar-email-ask',
        toolName: 'ask',
        toolDescription: 'Return the one text asking this family for an email address.',
        inputJsonSchema: askJsonSchema,
        schema: askSchema,
        userMessage: ASK_USER_MESSAGE,
        maxTokens: ASK_MAX_TOKENS,
        tidyValue: (value) => ({ text: tidy(value.text) }),
        violations: (value) => askViolations(value.text),
        render: (value) => value.text,
      });
      return result.status === 'composed'
        ? { status: 'composed', text: result.value.text, attempts: result.attempts }
        : result;
    },

    async composeNote(context) {
      const result = await run<{ subject: string; body: string }>({
        skillName: 'calendar-invite-note',
        toolName: 'note',
        toolDescription: 'Return the subject line and the short note above the invite.',
        inputJsonSchema: noteJsonSchema,
        schema: noteSchema,
        userMessage: inviteNoteUserMessage(context),
        maxTokens: NOTE_MAX_TOKENS,
        tidyValue: (value) => ({ subject: tidy(value.subject), body: tidy(value.body) }),
        violations: (value) => noteViolations(value, context),
        render: (value) => `subject: ${value.subject}\nbody: ${value.body}`,
      });
      return result.status === 'composed'
        ? {
            status: 'composed',
            subject: result.value.subject,
            body: result.value.body,
            attempts: result.attempts,
          }
        : result;
    },
  };
}

/** The composer every production caller uses: the shared lazy client, one skill load
 * per name, the gates and the retry budget. */
export function productionCalendarVoice(): CalendarVoice {
  return createCalendarVoice(calendarVoiceClient);
}

let cached: Anthropic | undefined;

/**
 * The shared client, resolved LAZILY — the router and the drain build these deps for
 * every text and every placement, including the ones that never reach a model, so a
 * missing key must not break construction. Throwing here (rather than returning null)
 * is what buys the composer's single named `client_unavailable` defer.
 */
export function calendarVoiceClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  cached ??= new Anthropic({ apiKey });
  return cached;
}
