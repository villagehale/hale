// Any language · reader + ask-back eval (Barton, 2026-10-25). Hard rule #8: no LLM mocking.
//
// Subjects are the REAL skills (reply-resolver.md, signup-consent.md) over the REAL request
// builders and readers imported from apps/web (resolve.ts, signup/consent-reader.ts). A
// Haiku judge scores the ask-back question for language and purpose; no word matching.
//
// Recorded 2026-10-25 (Barton OK 8:56 PM). CI replays it cached-only (eval:any-language). To re-record:
//   node evals/run-any-language-eval.mjs --max-usd <cumulative cap>   # live, then caches
//   node evals/run-any-language-eval.mjs --cached-only                # replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { ANY_LANGUAGE_FIXTURES } from './any-language-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const RESOLVE_SRC = join(WEB_ROOT, 'lib', 'channel', 'router', 'resolve.ts');
const CONSENT_SRC = join(WEB_ROOT, 'lib', 'signup', 'consent-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const QUESTION = {
  id: '7c2e9a10-4f3b-4d21-8e6a-1b9c0d2f3e41',
  kind: 'approval',
  description: 'Add to your calendar',
  subject: 'add to your calendar',
  answerable: { yes: true, no: true },
  askedAt: null,
  solicited: false,
};

const OFFER = {
  id: 'offer-1',
  familyId: 'family-1',
  childId: 'child-1',
  activityKey: 'swim-lessons-saturday',
  registrationUrl: 'https://example.org/swim/register',
  approvedPriceCents: 12000,
  sessions: [
    { id: 'sess-1', label: 'Saturday 10:00', startsAt: '2026-11-07T15:00:00.000Z', full: false },
  ],
};

const READING_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description:
        "The id of the question this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an answer but you cannot tell which question it answers.",
    },
    polarity: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['target', 'polarity', 'confidence'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short question Hale sends a parent who answered a',
  'signup offer with a hedge. You are given the parent message, the language they wrote in,',
  'and the question. Score 1-5 on MEANING, not wording. A 5 is in the same language as the',
  "parent's message, asks one plain thing that would settle whether to sign up, says nothing",
  'is booked, and does not tell them which word to type. Score LOW when it is in another',
  'language, claims a booking, presses them, or would not settle the offer.',
  'Reply with ONLY the score tool.',
].join(' ');

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('any-language');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const resolve = await importTs(RESOLVE_SRC);
  const consent = await importTs(CONSENT_SRC);
  const resolverSkill = await agent.loadSkill(join(SKILLS, 'reply-resolver.md'));
  const consentSkill = await agent.loadSkill(join(SKILLS, 'signup-consent.md'));
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'any-language', cachedOnly, getClient, cost);

  const results = [];
  for (const fixture of ANY_LANGUAGE_FIXTURES) {
    const failures = [];
    // 1. The reply reader: understood, and a hedge is an ask-back, never a write.
    const raw = (
      await cachedToolCall({
        tag: `any-language:resolver:${fixture.id}`,
        model: agent.pickModel(resolverSkill.meta.task),
        lane: agent.pickLane(resolverSkill.meta.task),
        system: resolverSkill.instructions,
        userMessage: resolve.replyResolverUserMessage(fixture.text, [QUESTION]),
        toolName: 'read_reply',
        toolSchema: READING_TOOL_SCHEMA,
        toolDescription: 'Read which open question the reply answers.',
        maxTokens: 256,
        cachedOnly,
        getClient,
        cost,
      })
    ).value;
    const reading = resolve.toReading(raw, [QUESTION]);
    if (fixture.kind === 'plain') {
      if (reading.status !== 'resolved' || reading.polarity !== 'yes') {
        failures.push(`reader: plain yes not understood (${JSON.stringify(reading)})`);
      }
    } else if (reading.status === 'resolved' || !resolve.warrantsClarifying(reading.reason)) {
      failures.push(`reader: hedge was not an ask-back (${JSON.stringify(reading)})`);
    }

    // 2. The signup reader: the same words, answered in the parent's language.
    const value = (
      await cachedToolCall({
        tag: `any-language:signup-consent:${fixture.id}`,
        model: agent.pickModel(consentSkill.meta.task),
        lane: agent.pickLane(consentSkill.meta.task),
        system: consentSkill.instructions,
        userMessage: consent.signupConsentUserMessage({ text: fixture.text, offer: OFFER }),
        toolName: consent.SIGNUP_CONSENT_TOOL,
        toolSchema: consent.SIGNUP_CONSENT_TOOL_SCHEMA,
        toolDescription: 'Decide whether the parent explicitly said to sign up for this offer.',
        maxTokens: consent.SIGNUP_CONSENT_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      })
    ).value;
    const signup = consent.toSignupConsentReading(value, OFFER);
    let question = null;
    if (fixture.kind === 'plain') {
      if (signup?.verdict !== 'consent') {
        failures.push(`signup: plain yes not consent (${JSON.stringify(signup)})`);
      }
    } else if (signup?.verdict !== 'unclear') {
      failures.push(`signup: hedge was not an ask-back (${JSON.stringify(signup)})`);
    } else {
      question = signup.question;
      const verdict = await judge(fixture.id, {
        input: JSON.stringify({ parentMessage: fixture.text, parentLanguage: fixture.language }),
        text: question,
        watchFor: `In ${fixture.language}. One question that settles the signup.`,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, reading, question, failures });
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(12)} "${r.fixture.text}"${r.question ? ` -> "${r.question}"` : ''}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('any-language eval harness error:', err);
  process.exit(2);
});
