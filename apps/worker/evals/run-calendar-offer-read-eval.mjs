// Calendar-offer reading eval (VIL-410).
//
// The model reads a parent's reply or a coach sentence. There is no composer and no
// second judge: the output is an id, a polarity, or a title and an instant, and those
// have an exactly right answer. Scored through the same parse production uses.
//
// No search. One forced tool call, max 256 tokens, Haiku (`task: screen`).
//
// Usage (from apps/worker):
//   node evals/run-calendar-offer-read-eval.mjs --preflight
//   node evals/run-calendar-offer-read-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CALENDAR_OFFER_FIXTURES } from './calendar-offer-read-fixtures.mjs';
import { cachedToolCall, lazyAnthropic, makeCost } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-offer-read.md');

/** Mirrors MAX_TOKENS in calendar-offer-read.ts. Folded into the cache tag. */
const MAX_TOKENS = 256;
const HAIKU_INPUT_PER_M = 1;
const HAIKU_OUTPUT_PER_M = 5;
const EXPECTED_OUTPUT_TOKENS = 120;

const PARENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description:
        "The id of the offer this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an answer but you cannot tell which offer.",
    },
    polarity: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['target', 'polarity', 'confidence', 'reason'],
};

const COACH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    offer: {
      type: 'boolean',
      description:
        'True only when the sentence offers to add one specific occasion that has not started.',
    },
    title: {
      type: 'string',
      description: 'The occasion title from the sentence, or empty when offer is false.',
    },
    startsAt: {
      type: 'string',
      description: 'ISO-8601 start instant, or empty when offer is false.',
    },
    location: { type: 'string', description: 'Place from the sentence, or empty.' },
    reason: { type: 'string' },
  },
  required: ['offer', 'title', 'startsAt', 'location', 'reason'],
};

const GRADE = { email_alert_add: 'consequential' };

function parentUserMessage(fixture) {
  return JSON.stringify({
    role: 'parent',
    now: fixture.now,
    text: fixture.text,
    questions: fixture.questions.map((question) => ({
      id: question.id,
      question: question.description,
    })),
  });
}

function coachUserMessage(fixture) {
  return JSON.stringify({
    role: 'coach',
    now: fixture.now,
    timeZone: fixture.timeZone,
    text: fixture.text,
  });
}

function userMessage(fixture) {
  return fixture.role === 'coach' ? coachUserMessage(fixture) : parentUserMessage(fixture);
}

function meetsGrade(kind, confidence) {
  if (confidence === 'low') return false;
  return GRADE[kind] === 'ordinary' || confidence === 'high';
}

function toReading(raw, questions) {
  if (raw.polarity !== 'yes' && raw.polarity !== 'no')
    return { status: 'unresolved', reason: 'no_target' };
  if (raw.target === 'none') return { status: 'unresolved', reason: 'no_target' };
  if (raw.target === 'ambiguous') return { status: 'unresolved', reason: 'ambiguous' };
  const question = questions.find((row) => row.id === raw.target);
  if (!question) return { status: 'unresolved', reason: 'unreadable' };
  const confidence =
    raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low';
  if (!meetsGrade(question.kind, confidence))
    return { status: 'unresolved', reason: 'below_grade' };
  const answerable = question.answerable ?? { yes: true, no: true };
  if (!answerable[raw.polarity]) return { status: 'unresolved', reason: 'not_answerable' };
  return {
    status: 'resolved',
    questionId: question.id,
    kind: question.kind,
    polarity: raw.polarity,
    confidence,
  };
}

function parseParent(raw) {
  return ['target', 'polarity', 'confidence'].every((field) => typeof raw[field] === 'string')
    ? raw
    : null;
}

function toCoachOffer(raw) {
  if (raw.offer !== true) return { status: 'none', reason: 'no_offer' };
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title === '') return { status: 'none', reason: 'unreadable' };
  const startsAt = new Date(raw.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { status: 'none', reason: 'unreadable' };
  return { status: 'offer', title, startsAt: startsAt.toISOString() };
}

function check(fixture, outcome) {
  const want = fixture.expect;
  const failures = [];
  if (
    fixture.pastOfferId &&
    outcome.status === 'resolved' &&
    outcome.questionId === fixture.pastOfferId &&
    outcome.polarity === 'yes'
  ) {
    failures.push('VIL-410: a bare yes would add the past event');
  }
  if (outcome.status !== want.status) {
    failures.push(`status ${outcome.status} - wanted ${want.status}`);
    return failures;
  }
  if (want.status === 'unresolved' && want.reason && outcome.reason !== want.reason) {
    failures.push(`reason ${outcome.reason} - wanted ${want.reason}`);
  }
  if (want.status === 'resolved') {
    if (outcome.questionId !== want.questionId) {
      failures.push(`WRONG TARGET: ${outcome.questionId} - wanted ${want.questionId}`);
    }
    if (outcome.polarity !== want.polarity) {
      failures.push(`polarity ${outcome.polarity} - wanted ${want.polarity}`);
    }
  }
  if (want.status === 'offer') {
    if (outcome.title !== want.title)
      failures.push(`title ${outcome.title} - wanted ${want.title}`);
    if (outcome.startsAt !== want.startsAt) {
      failures.push(`startsAt ${outcome.startsAt} - wanted ${want.startsAt}`);
    }
  }
  return failures;
}

function estimate(skillChars, fixtures) {
  let expected = 0;
  let largestInput = 0;
  for (const fixture of fixtures) {
    const inputTokens = Math.ceil((skillChars + userMessage(fixture).length) / 4);
    largestInput = Math.max(largestInput, inputTokens);
    expected +=
      (inputTokens / 1e6) * HAIKU_INPUT_PER_M + (EXPECTED_OUTPUT_TOKENS / 1e6) * HAIKU_OUTPUT_PER_M;
  }
  const hold = (MAX_TOKENS / 1e6) * HAIKU_OUTPUT_PER_M;
  return { expected, hold, largestInput };
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const fixtures = CALENDAR_OFFER_FIXTURES;
  const quote = estimate(skill.instructions.length, fixtures);

  if (preflight) {
    console.info(`calendar-offer-read preflight | fixtures=${fixtures.length} model=${model}`);
    console.info('search turns: 0');
    console.info(
      `largest single pre-call hold: $${quote.hold.toFixed(6)} (${MAX_TOKENS} output tokens)`,
    );
    console.info(`largest input estimate: ${quote.largestInput} tokens`);
    console.info(
      `expected cost: $${quote.expected.toFixed(6)} (${fixtures.length} calls, ~${EXPECTED_OUTPUT_TOKENS} output tokens each)`,
    );
    console.info(`max API calls: subject=${fixtures.length}, judges=0`);
    return;
  }

  const getClient = lazyAnthropic();
  const cost = makeCost();
  const results = [];
  for (const fixture of fixtures) {
    const coach = fixture.role === 'coach';
    const call = await cachedToolCall({
      tag: `calendar-offer-read:${MAX_TOKENS}:${fixture.id}`,
      model,
      system: skill.instructions,
      userMessage: userMessage(fixture),
      toolName: coach ? 'read_coach_sentence' : 'read_parent_reply',
      toolSchema: coach ? COACH_TOOL_SCHEMA : PARENT_TOOL_SCHEMA,
      toolDescription: coach
        ? 'Read whether this sentence offers to add one specific future occasion.'
        : 'Read which open calendar offer this reply answers, and whether it was a yes or a no.',
      maxTokens: MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const outcome = coach
      ? toCoachOffer(call.value)
      : (() => {
          const parsed = parseParent(call.value);
          return parsed
            ? toReading(parsed, fixture.questions)
            : { status: 'unresolved', reason: 'model_failed' };
        })();
    results.push({ fixture, outcome, failures: check(fixture, outcome), raw: call.value });
  }

  for (const result of results) {
    const tag = result.failures.length === 0 ? 'PASS' : 'FAIL';
    console.info(`${tag}  ${result.fixture.id}  ${result.outcome.status}`);
    for (const failure of result.failures) console.info(`      ${failure}`);
  }
  const failed = results.filter((result) => result.failures.length > 0);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
