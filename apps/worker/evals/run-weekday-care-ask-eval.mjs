// VIL-360 · weekday-care ask eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/weekday-care-ask.md, called the way the runtime calls it
// (apps/web/lib/channel/nudge/nudge-voice.ts): the `weekday_ask` tool forced on the
// skill's lane, then the runtime's own check (readWeekdayAsk). The grade is the text a
// parent would read.
//
// The model picks the words, so nothing here counts question marks, demands a word or
// bans a phrase. Deterministic gates are kept only for what is never the model's call:
// a word for the parent to reply with, and the language where a reader exists for it.
// Whether the text is the chosen offer, about the right child or break, carries one ask,
// claims nothing Hale has not done and reads like a friend texting is the judge's grade.
//
//   ANTHROPIC_API_KEY=... node evals/run-weekday-care-ask-eval.mjs   # live, populates the cache
//   node evals/run-weekday-care-ask-eval.mjs --cached-only           # CI: replay, zero API calls

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  REPO_ROOT,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';
import { WEEKDAY_CARE_ASK_FIXTURES } from './weekday-care-ask-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'weekday-care-ask.md');
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'nudge', 'weekday-ask-tools.ts');
const LANGUAGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'language.ts');

/** A reply word the founder rules forbid Hale to teach. */
const KEYWORD_TEACHING = ['reply yes', 'reply no', 'text yes'];

/**
 * Deterministic language evidence where a reader exists: Han script for Chinese, the
 * runtime's own French reader (lib/channel/language.ts) for French, and for English the
 * absence of both. Spanish has no reader here, so only the judge grades it.
 */
function languageEvidence(language, text, replyLanguage) {
  const han = /\p{Script=Han}/u.test(text);
  if (language === 'zh') return han;
  if (language === 'fr') return replyLanguage(text) === 'fr';
  if (language === 'en') return !han && replyLanguage(text) !== 'fr';
  return null;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale, a family planner that lives in',
  "the parent's messages, sends a parent. Hale already sent this family weekend options;",
  'this text offers to look for something on weekdays. Nothing has been found yet.',
  'You are given `context` - exactly what the writer was given: `prompt` (which offer),',
  "`language` (the family's language) and, for some prompts, `name` (the one child it may",
  'name) or `label` (a school break on the family calendar) - and the `text`. Score 1-5.',
  'Write your argument first, quoting the text, and only then the score.',
  'The offer, by prompt: after_school_named offers to find an after-school option for the',
  'child called `name`; after_school_household offers an after-school option nearby and',
  'names no child; verified_break says the break in `label` is coming and offers to find',
  'something for it; weekend_fallback offers to look at weekdays too and names no child.',
  'A 5 is that offer, unmistakably, in one light text written in `language` - spelled',
  'properly, every accent in place, natural for how people text in that language - that',
  'reads like a friend who is also a parent texting: chill, casual, easy to ignore, a',
  "friend who noticed something about this family's week and is curious about it, so the",
  'text is about the family.',
  'Do not grade word choice, length or punctuation for their own sake; the writer picks',
  'the words. Grade whether a parent would read it as a friend texting about this offer.',
  'A 1 or 2 is any of: a text not in `language`, or with its accents stripped; the wrong',
  "offer, or the offer's child or break missing or wrong; a child named that `context`",
  "does not give, or a child's age, grade or stage; an activity, place, time, price or",
  'link (nothing has been found); a claim that Hale has already looked for, or found, what',
  'this text offers to look for (it has not: only the weekend options were sent); a word',
  'the parent is told to reply with; more than one offer; more than one ask (a question',
  'about their week plus the offer counts as two). A 3 is the right offer that reads like',
  'an assistant offering a service rather than a friend texting: formal, stiff,',
  'survey-like or salesy, or a text about its own help - what it could do, how willing it',
  'is, whether that would be useful - rather than about the family. However casual its',
  'words, a hedged offer of service is a 3.',
  'Check two things in your argument before you weigh the tone. First, list everything',
  'the text asks the parent and say how many asks that is; the offer itself, put to the',
  'parent, is one ask. Second, quote the part of the text that makes the offer and judge',
  'that part on its own against the 3 line: is it a hedged offer of service - help held',
  'out on the condition that it would be useful or wanted, or said as what Hale is able',
  'or willing to do - rather than the offer put straight? If it is, the text is a 3 at',
  'most, however friendly the rest of it reads.',
  'Reply with ONLY the score tool.',
].join(' ');

function grade(fixture, written, replyLanguage, verdict) {
  if ('skipped' in written) return [`refused by the runtime check: ${written.skipped}`];
  const failures = [];
  const body = written.message.toLowerCase();
  for (const phrase of KEYWORD_TEACHING) {
    if (body.includes(phrase)) failures.push(`teaches the reply word "${phrase}"`);
  }
  if (languageEvidence(fixture.language, written.message, replyLanguage) === false) {
    failures.push(`not written in ${fixture.language}`);
  }
  if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
  return failures;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const { replyLanguage } = await tsImport(LANGUAGE_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'weekday-care-ask',
    cachedOnly,
    getClient,
    cost,
  );

  console.info(
    `weekday-care-ask | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} judge=${judgeModel} | fixtures=${WEEKDAY_CARE_ASK_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of WEEKDAY_CARE_ASK_FIXTURES) {
    const context = tools.weekdayAskContext(fixture.ask, fixture.language);
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`weekday-care-ask:${fixture.id}`),
      system: skill.instructions,
      userMessage: context,
      toolName: tools.WEEKDAY_ASK_TOOL,
      toolDescription: 'The one text Hale sends.',
      toolSchema: tools.WEEKDAY_ASK_TOOL_SCHEMA,
      maxTokens: tools.WEEKDAY_ASK_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const written = tools.readWeekdayAsk(call.value, fixture.ask);
    const verdict =
      'message' in written
        ? await judge(fixture.id, { context: JSON.parse(context), text: written.message })
        : null;
    const failures = grade(fixture, written, replyLanguage, verdict);
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if ('message' in written) console.info(`        > ${written.message}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  if (misses.length > 0) {
    console.error(`weekday-care-ask: ${misses.length} cache miss(es) in --cached-only`);
    for (const miss of misses) console.error(`  ${miss}`);
    process.exit(1);
  }
  const passed = WEEKDAY_CARE_ASK_FIXTURES.length - failed;
  console.info(
    `\n${passed}/${WEEKDAY_CARE_ASK_FIXTURES.length} passed | live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
