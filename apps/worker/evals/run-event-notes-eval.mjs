// The event-notes reader eval (VIL-468; hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/event-notes-read.md) run through
// the REAL forced-tool-JSON request shape apps/web/lib/integrations/event-notes.ts builds,
// replicated here. The skill body and model routing are imported live, so a skill edit
// re-keys the cache. A judge scores each reading by MEANING against the description.
//
// Usage (from apps/worker):
//   node evals/run-event-notes-eval.mjs --dry           # $0, no API: worst-case $
//   node evals/run-event-notes-eval.mjs --broken        # calibration, $0 subject: must FAIL
//   node evals/run-event-notes-eval.mjs --cached-only   # replay only, $0 (misses fail)
//   node --env-file=../../.env evals/run-event-notes-eval.mjs --live   # PAID - needs Barton's yes
// Any other flag, or none, exits 2 before the spend cap or a client exists.
//
// NOT in CI yet: there is no recorded cache, and recording it is a paid run.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { BROKEN_READING, EVENT_NOTES_FIXTURES } from './event-notes-fixtures.mjs';
import { dryClient, parseEventNotesFlags } from './event-notes-flags.mjs';
import {
  JUDGE_MIN,
  PRICE,
  cacheGet,
  cacheKey,
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
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'event-notes-read.md');

// ── the reader's request shape, replicated from event-notes.ts ──────────────

const MAX_TOKENS = 512;
const TOOL_NAME = 'read_event_notes';
const TOOL_DESCRIPTION =
  'Return the parking and what-to-bring facts this event description states, or empty strings.';
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    parking: {
      type: 'string',
      description: 'Parking for this event as the description states it, or empty.',
    },
    bring: {
      type: 'string',
      description: 'What to bring for this event as the description states it, or empty.',
    },
  },
  required: ['parking', 'bring'],
};

/** Mirrors `eventNotesUserMessage` in event-notes.ts. */
const userMessage = (f) => JSON.stringify({ title: f.title, description: f.description });

// ── the judge: MEANING only ─────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE structured reading of a calendar event description.',
  'The reader had to return only the parking and what-to-bring facts the description STATES',
  "for THIS event, in the description's own language, or an empty string for a fact that is",
  'not stated. You are given the title, the description, the reading, and `expect`: a prose',
  'note of what the description states (null means not stated) and any trap. Judge by',
  'MEANING, not wording: any phrasing that carries the same facts is correct. Score 1-5.',
  'A 5 has every stated fact with no detail a parent needs lost, nothing invented or inferred,',
  'an empty field where nothing is stated, the source language kept, and no names, phone',
  'numbers, prices unrelated to parking, or other content. A LOW score is any of: an invented',
  'or inferred fact (including what is usual for this kind of event); a fact from a different',
  'event; a stated fact missing or cut short; translated into another language; extra',
  'unrelated content. Reply with ONLY the score tool.',
].join(' ');

function judgeInput(fixture, reading) {
  return {
    title: fixture.title,
    description: fixture.description,
    reading: { parking: reading.parking ?? '', bring: reading.bring ?? '' },
    expect: fixture.expect,
    ...(fixture.trap ? { trap: fixture.trap } : {}),
  };
}

// ── --dry ───────────────────────────────────────────────────────────────────

/** Offline token estimate, the same 1-per-3-bytes ratio the other dry runs use. */
const tokensFor = (text) => Math.ceil(text.length / 3);

function worstUsd(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}

/**
 * No client, no spend cap, no model call. Keys every subject draw exactly as
 * cachedToolCall does and every judge draw exactly as makeJudge does, and prices each
 * miss at its full output ceiling. A judge whose subject is not cached is priced with a
 * MAX_TOKENS-long reading.
 */
async function dryRun({ agent, skill, lane, model, judgeModel }) {
  const judgeMaxOut = judgeModel === agent.HAIKU_MODEL ? 4096 : 8192;
  const draws = { subject: [0, 0], judge: [0, 0] };
  let worst = 0;
  for (const fixture of EVENT_NOTES_FIXTURES) {
    const tag = `event-notes:${MAX_TOKENS}:${fixture.id}`;
    const message = userMessage(fixture);
    const key = cacheKey(
      tag,
      JSON.stringify({
        model,
        system: skill.instructions,
        userMessage: message,
        toolName: TOOL_NAME,
        toolSchema: TOOL_SCHEMA,
        lane,
      }),
    );
    const cached = await cacheGet(key);
    let judgeMessage;
    if (cached) {
      draws.subject[0] += 1;
      console.log(`DRY  cached    ${tag}`);
      judgeMessage = JSON.stringify(judgeInput(fixture, cached.value ?? {}));
    } else {
      const inTokens = tokensFor(skill.instructions + message + JSON.stringify(TOOL_SCHEMA));
      const usd = worstUsd(model, inTokens, MAX_TOKENS);
      draws.subject[1] += 1;
      worst += usd;
      console.log(
        `DRY  uncached  ${tag}  ~${inTokens} in + ${MAX_TOKENS} max out  worst $${usd.toFixed(5)}`,
      );
    }
    const judgeTag = `event-notes:judge:${fixture.id}`;
    if (judgeMessage !== undefined) {
      const judgeKey = cacheKey(judgeTag, `${judgeModel}\n${JUDGE_SYSTEM}\n${judgeMessage}`);
      if (await cacheGet(judgeKey)) {
        draws.judge[0] += 1;
        console.log(`DRY  cached    ${judgeTag}`);
        continue;
      }
    }
    const filler = 'x'.repeat(MAX_TOKENS * 2);
    const msg =
      judgeMessage ?? JSON.stringify(judgeInput(fixture, { parking: filler, bring: filler }));
    const inTokens = tokensFor(JUDGE_SYSTEM + msg);
    const usd = worstUsd(judgeModel, inTokens, judgeMaxOut);
    draws.judge[1] += 1;
    worst += usd;
    console.log(
      `DRY  uncached  ${judgeTag}  ~${inTokens} in + ${judgeMaxOut} max out  worst $${usd.toFixed(5)}`,
    );
  }
  // --broken scores the stand-in reading with the same judge; those draws are paid too.
  for (const fixture of EVENT_NOTES_FIXTURES) {
    const judgeTag = `event-notes:judge:${fixture.id}`;
    const msg = JSON.stringify(judgeInput(fixture, BROKEN_READING));
    if (await cacheGet(cacheKey(judgeTag, `${judgeModel}\n${JUDGE_SYSTEM}\n${msg}`))) {
      draws.judge[0] += 1;
      console.log(`DRY  cached    ${judgeTag} (broken)`);
      continue;
    }
    const inTokens = tokensFor(JUDGE_SYSTEM + msg);
    const usd = worstUsd(judgeModel, inTokens, judgeMaxOut);
    draws.judge[1] += 1;
    worst += usd;
    console.log(
      `DRY  uncached  ${judgeTag} (broken)  ~${inTokens} in + ${judgeMaxOut} max out  worst $${usd.toFixed(5)}`,
    );
  }
  const [sc, su] = draws.subject;
  const [jc, ju] = draws.judge;
  console.log(
    `DRY summary | subject draws ${sc + su} (cached ${sc}, uncached ${su}) | judge draws ${jc + ju} (cached ${jc}, uncached ${ju}) worst $${worst.toFixed(5)}`,
  );
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

async function main() {
  let mode;
  try {
    mode = parseEventNotesFlags(process.argv.slice(2));
  } catch (err) {
    console.error(`event-notes eval: ${err.message}`);
    process.exit(2);
  }
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  if (mode === 'dry') {
    console.log(
      `event-notes eval | mode=dry (no API calls) | subject=${model} judge=${judgeModel}`,
    );
    await dryRun({ agent, skill, lane, model, judgeModel });
    return;
  }
  const broken = mode === 'broken';
  const cachedOnly = mode === 'cached-only' || broken;
  installEvalSpendCap();
  // Belt and braces: only --live ever gets a real client.
  const getClient = mode === 'live' ? lazyAnthropic('event-notes') : dryClient;
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'event-notes', cachedOnly, getClient, cost);

  console.log(`event-notes eval | mode=${mode} | subject=${model} judge=${judgeModel}`);
  const results = [];
  for (const fixture of EVENT_NOTES_FIXTURES) {
    const reading = broken
      ? BROKEN_READING
      : (
          await cachedToolCall({
            tag: `event-notes:${MAX_TOKENS}:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: userMessage(fixture),
            toolName: TOOL_NAME,
            toolSchema: TOOL_SCHEMA,
            toolDescription: TOOL_DESCRIPTION,
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    const failures = [];
    if (typeof reading?.parking !== 'string' || typeof reading?.bring !== 'string') {
      failures.push('unreadable (notes stay null)');
    } else {
      const verdict = await judge(fixture.id, judgeInput(fixture, reading));
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, reading, failures });
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id}  ${JSON.stringify(r.reading)}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (broken) process.exit(allPass ? 1 : 0);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('event-notes eval harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
