// Group RSVP voice · composer eval (VIL-102, hard rule #8: no LLM mocking).
// A judge scores meaning 1-5. No wording rules.
//
//   node evals/run-group-rsvp-voice-eval.mjs --max-usd 0.40
//   node evals/run-group-rsvp-voice-eval.mjs --broken
//   node evals/run-group-rsvp-voice-eval.mjs --cached-only
//
// Dry worst-case for one live run (3 compose + 3 Opus judges, one retry): ~$0.12.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_RSVP_VOICE_FIXTURES } from './group-rsvp-voice-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-rsvp-voice.md');
const INPUT_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-rsvp-line-input.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    send: { type: 'boolean' },
    line: { type: 'string' },
    question: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['send', 'line', 'question', 'why'],
};

const JUDGE_SYSTEM = [
  'You score ONE short group-chat RSVP line Hale posted, 1 to 5, on meaning only.',
  'A 5 keeps the counts and names that are in the facts, asks at most one question,',
  'never invents who is free or busy, never claims a calendar write that did not happen,',
  'and stays a plain short text with no poll, button, link, or reply-word instruction.',
  'A 1 invents a count, a name, availability, or a calendar write, or tells people to tap a button.',
  'Do not score wording. Reply with ONLY the score tool.',
].join(' ');

const BROKEN = '6 yes, 2 to go · on everyone’s calendar!! Reply YES https://hale.test 🎉';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('group-rsvp-voice');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { groupRsvpLineInput } = await importTs(INPUT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'group-rsvp-voice', cachedOnly, getClient, cost);

  console.log(
    `group-rsvp-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of GROUP_RSVP_VOICE_FIXTURES) {
    const input = groupRsvpLineInput({
      kind: fixture.kind,
      language: fixture.language,
      parentWords: fixture.parentWords,
      tally: fixture.facts,
      title: fixture.facts.title,
      whenText: fixture.facts.whenText,
      location: fixture.facts.location,
      justChanged: fixture.facts.justChanged,
      calendarAskFor: fixture.facts.calendarAskFor,
      calendarPlacedFor: fixture.facts.calendarPlacedFor,
      inviteSent: fixture.facts.inviteSent,
      send: fixture.facts.send,
    });
    const userMessage = JSON.stringify({
      kind: input.kind,
      language: input.language,
      parentWords: input.parentWords,
      facts: input.facts,
      questions: input.questions,
    });
    let body;
    if (broken) {
      body = BROKEN;
    } else {
      const value = (
        await cachedToolCall({
          tag: `group-rsvp-voice:${fixture.id}`,
          model,
          lane,
          system: skill.instructions,
          userMessage,
          toolName: 'send_group_rsvp_line',
          toolSchema: TOOL_SCHEMA,
          toolDescription: 'Return the one RSVP line Hale should post, or send false.',
          maxTokens: 300,
          cachedOnly,
          getClient,
          cost,
        })
      ).value;
      body = value.send ? value.line.trim() : '';
    }
    const failures = [];
    if (body.length === 0 || /https?:\/\//i.test(body)) failures.push('unusable');
    const verdict = await judge(fixture.id, {
      input: userMessage,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures, score: verdict.score });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} judge:${r.score} "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  console.log('dry worst-case one live run: $0.12 (3 compose + 3 Opus judges, one retry)');
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-rsvp-voice eval harness error:', err);
  process.exit(2);
});
