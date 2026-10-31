// Group plan RSVP · reader + voice eval (VIL-442, hard rule #8: no LLM mocking).
//
// The subjects are the REAL skills through the REAL request shapes:
//   packages/agent/skills/group-plan-rsvp-read.md  + groupPlanRsvpUserMessage
//   packages/agent/skills/group-plan-rsvp-voice.md + groupPlanRsvpLineInput
// A judge scores meaning, 1-5. No word-matching gate.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up.
// It is not in ci.yml.
//
//   node evals/group-plan-rsvp-eval.mjs --estimate
//   HALE_SPEND_LEDGER=... node evals/group-plan-rsvp-eval.mjs --live --max-usd 0.03
//   node evals/group-plan-rsvp-eval.mjs --cached-only
//
// --estimate prices one live recording of every fixture (reader + voice + judge)
// at max_tokens and exits 0. It does not call the API and it does not write cache.
// --live records every cache miss (subject + judge) through the production seam under
// installEvalSpendCap: no --max-usd / HALE_SPEND_LEDGER means no call is made, and the
// cap refuses any call whose worst case would cross it. It also refuses to start when
// the estimate is above --max-usd.
// --cached-only replays committed cache. The first miss prints that same estimate
// and exits 1.

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import {
  GROUP_PLAN_RSVP_READ_FIXTURES,
  GROUP_PLAN_RSVP_VOICE_FIXTURES,
} from "./group-plan-rsvp-fixtures.mjs";
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  evalRunTag,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  scoreFirstJudgeSchema,
  totalUsd,
} from "./lib/harness.mjs";

const WEB_TSCONFIG = join(REPO_ROOT, "apps", "web", "tsconfig.json");
const AGENT_SRC = join(REPO_ROOT, "packages", "agent", "src", "index.ts");
const READ_SKILL_PATH = join(
  REPO_ROOT,
  "packages",
  "agent",
  "skills",
  "group-plan-rsvp-read.md",
);
const VOICE_SKILL_PATH = join(
  REPO_ROOT,
  "packages",
  "agent",
  "skills",
  "group-plan-rsvp-voice.md",
);
const READING_SRC = join(
  REPO_ROOT,
  "apps",
  "web",
  "lib",
  "channel",
  "linq",
  "group-plan-rsvp",
  "reading.ts",
);
const FACTS_SRC = join(
  REPO_ROOT,
  "apps",
  "web",
  "lib",
  "channel",
  "linq",
  "group-plan-rsvp",
  "facts.ts",
);
const TALLY_SRC = join(
  REPO_ROOT,
  "apps",
  "web",
  "lib",
  "channel",
  "linq",
  "group-plan-rsvp",
  "tally.ts",
);
const VOICE_SRC = join(
  REPO_ROOT,
  "apps",
  "web",
  "lib",
  "channel",
  "linq",
  "group-plan-rsvp",
  "voice.ts",
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_REASON_MAX_CHARS = 160;
const JUDGE_TOOL_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);
const JUDGE_MAX_TOKENS = 440;

const READ_JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE reading of a group-chat message about a shared plan.",
  "You are given `situation` and `reading`. `reading` is the model tool output: intent,",
  "response, headcount, householdLabel, coversNames, confidence. Score 1-5 on MEANING.",
  "Do not require particular words. A 5 matches the situation. A 1 or 2 is the wrong intent",
  "(a vote read as chatter, chatter read as a vote, a household answer missing the household).",
  "Reply with ONLY the score tool. score first, then reason. Reason at most",
  `${JUDGE_REASON_MAX_CHARS} characters.`,
].join(" ");

const VOICE_JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE message Hale posts in a group chat about a plan it is tracking.",
  "You are given `situation`, `watchFor`, `facts`, and `message`. Score 1-5 on FACTS and TONE, not wording.",
  "A 5 gets the yes / no / waiting picture and the deadline from facts, in its own words, short and plain.",
  "A LOW score invents a calendar, a poll, a button, a reply keyword, a name or number not in facts,",
  "or claims Hale can see email or a private calendar. Reply with ONLY the score tool.",
].join(" ");

const JUDGE_TOOL = {
  name: "score",
  description: "Return the score.",
  input_schema: JUDGE_TOOL_SCHEMA,
};

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function suiteUsd({
  readLane,
  voiceLane,
  readSkill,
  voiceSkill,
  reading,
  facts,
  tally,
  voice,
  judgeModel,
}) {
  let usd = 0;
  for (const fixture of GROUP_PLAN_RSVP_READ_FIXTURES) {
    const userMessage = reading.groupPlanRsvpUserMessage(fixture.input);
    const input =
      estimateTokens(readSkill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: "group_plan_rsvp",
        input_schema: reading.GROUP_PLAN_RSVP_READ_TOOL_SCHEMA,
      });
    usd += priced(
      readLane.model,
      input,
      reading.GROUP_PLAN_RSVP_READ_MAX_TOKENS,
    );
    usd += priced(
      judgeModel,
      estimateTokens(READ_JUDGE_SYSTEM) +
        estimateTokens({
          situation: fixture.situation,
          reading: { intent: "chatter" },
        }) +
        estimateTokens(JUDGE_TOOL),
      JUDGE_MAX_TOKENS,
    );
  }
  for (const fixture of GROUP_PLAN_RSVP_VOICE_FIXTURES) {
    const input = voiceInput(fixture, facts, tally);
    const userMessage = JSON.stringify(input);
    usd += priced(
      voiceLane.model,
      estimateTokens(voiceSkill.instructions) + estimateTokens(userMessage),
      voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
    );
    usd += priced(
      judgeModel,
      estimateTokens(VOICE_JUDGE_SYSTEM) +
        estimateTokens({
          situation: fixture.situation,
          watchFor: fixture.watchFor,
          facts: input.facts,
          message: "",
        }) +
        estimateTokens(JUDGE_TOOL) +
        voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
      JUDGE_MAX_TOKENS,
    );
  }
  return usd;
}

function voiceInput(fixture, facts, tally) {
  return facts.groupPlanRsvpLineInput({
    kind: fixture.kind,
    language: "en",
    title: fixture.title,
    deadline: fixture.deadline,
    tally: tally.tallyPlanRsvps(fixture.rows, fixture.expected),
  });
}

/** The exact tool shape productionGroupPlanRsvpComposer sends for this input. */
function voiceToolSchema(questions) {
  return questions === 1
    ? {
        type: "object",
        additionalProperties: false,
        properties: {
          send: { type: "boolean" },
          before: { type: "string" },
          question: { type: "string" },
          why: { type: "string" },
        },
        required: ["send", "before", "question"],
      }
    : {
        type: "object",
        additionalProperties: false,
        properties: {
          send: { type: "boolean" },
          line: { type: "string" },
          why: { type: "string" },
        },
        required: ["send", "line"],
      };
}

/** The member-facing gate in voice.ts lineUsable. Shape only, never words. */
function lineUsable(line, questions) {
  if (!line.trim()) return false;
  if (/https?:\/\//i.test(line)) return false;
  if (questions === 1 && !line.includes("?")) return false;
  if (questions === 0 && line.includes("?")) return false;
  return true;
}

function maxUsdArg(argv) {
  const i = argv.findIndex(
    (a) => a === "--max-usd" || a.startsWith("--max-usd="),
  );
  if (i < 0) return Number(process.env.HALE_MAX_USD ?? Number.NaN);
  return Number(argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1]);
}

function estimateLine(usd) {
  return `group-plan-rsvp: one estimate to record ${GROUP_PLAN_RSVP_READ_FIXTURES.length} reader fixtures and ${GROUP_PLAN_RSVP_VOICE_FIXTURES.length} voice fixtures (subject + judge), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const estimateOnly = process.argv.includes("--estimate");
  const cachedOnly = process.argv.includes("--cached-only");
  const live = process.argv.includes("--live");
  if ([estimateOnly, cachedOnly, live].filter(Boolean).length !== 1) {
    console.error(
      "group-plan-rsvp: pass exactly one of --estimate, --live --max-usd N, --cached-only",
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(READING_SRC);
  const facts = await importTs(FACTS_SRC);
  const tally = await importTs(TALLY_SRC);
  const voice = await importTs(VOICE_SRC);
  const readSkill = await agent.loadSkill(READ_SKILL_PATH);
  const voiceSkill = await agent.loadSkill(VOICE_SKILL_PATH);
  const readLane = agent.pickLane(readSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = suiteUsd({
    readLane,
    voiceLane,
    readSkill,
    voiceSkill,
    reading,
    facts,
    tally,
    voice,
    judgeModel,
  });

  if (estimateOnly) {
    console.info(estimateLine(usd));
    return;
  }
  if (live) {
    const maxUsd = maxUsdArg(process.argv);
    if (!(maxUsd > 0)) {
      console.error("group-plan-rsvp: --live needs --max-usd N");
      process.exit(2);
    }
    if (usd > maxUsd) {
      console.error(estimateLine(usd));
      console.error(
        `group-plan-rsvp: estimate is above --max-usd $${maxUsd}. stopped. nothing recorded.`,
      );
      process.exit(1);
    }
    console.info(estimateLine(usd));
    installEvalSpendCap();
  } else {
    // A cached-only miss exits inside the harness; say first what recording it would cost.
    console.info(estimateLine(usd));
  }

  const getClient = lazyAnthropic("group-plan-rsvp");
  const cost = makeCost();
  const judgeOptions = {
    toolSchema: JUDGE_TOOL_SCHEMA,
    maxOutputTokens: JUDGE_MAX_TOKENS,
  };
  const readJudge = makeJudge(
    judgeModel,
    READ_JUDGE_SYSTEM,
    "group-plan-rsvp-read",
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  const voiceJudge = makeJudge(
    judgeModel,
    VOICE_JUDGE_SYSTEM,
    "group-plan-rsvp-voice",
    cachedOnly,
    getClient,
    cost,
    judgeOptions,
  );
  let allPass = true;

  for (const fixture of GROUP_PLAN_RSVP_READ_FIXTURES) {
    const { value } = await cachedToolCall({
      tag: evalRunTag(`group-plan-rsvp-read:${fixture.id}`),
      lane: readLane,
      system: readSkill.instructions,
      userMessage: reading.groupPlanRsvpUserMessage(fixture.input),
      toolName: "group_plan_rsvp",
      toolDescription:
        "Return what this group message meant for a shared plan.",
      toolSchema: reading.GROUP_PLAN_RSVP_READ_TOOL_SCHEMA,
      maxTokens: reading.GROUP_PLAN_RSVP_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const verdict = await readJudge(fixture.id, {
      situation: fixture.situation,
      reading: value,
    });
    const ok =
      verdict.score >= JUDGE_MIN && fixture.accept.includes(value.intent);
    if (!ok) allPass = false;
    console.info(
      `${ok ? "PASS" : "FAIL"}  read:${fixture.id}  intent=${value.intent} judge:${verdict.score}`,
    );
    if (!ok) console.info(`      · ${verdict.reason}`);
  }

  for (const fixture of GROUP_PLAN_RSVP_VOICE_FIXTURES) {
    const input = voiceInput(fixture, facts, tally);
    const { value } = await cachedToolCall({
      tag: evalRunTag(`group-plan-rsvp-voice:${fixture.id}`),
      lane: voiceLane,
      system: voiceSkill.instructions,
      userMessage: JSON.stringify({ ...input, retry: false }),
      toolName: "send_group_line",
      toolDescription: "The one message Hale sends.",
      toolSchema: voiceToolSchema(input.questions),
      maxTokens: voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const line =
      input.questions === 1
        ? [value.before, value.question].filter(Boolean).join(" ").trim()
        : String(value.line ?? "").trim();
    const usable = value.send === true && lineUsable(line, input.questions);
    const verdict = await voiceJudge(fixture.id, {
      situation: fixture.situation,
      watchFor: fixture.watchFor,
      facts: input.facts,
      message: line,
    });
    const ok = usable && verdict.score >= JUDGE_MIN;
    if (!ok) allPass = false;
    console.info(
      `${ok ? "PASS" : "FAIL"}  voice:${fixture.id}  judge:${verdict.score}${usable ? "" : " unusable"}  "${line}"`,
    );
    if (!ok) console.info(`      · ${verdict.reason}`);
  }

  console.info(
    `live API calls this run: ${cost.liveCalls} | actual cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!allPass) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(
      err instanceof Error ? err.message : "group-plan-rsvp failed",
    );
    process.exit(1);
  });
}

export { estimateLine, main, suiteUsd };
