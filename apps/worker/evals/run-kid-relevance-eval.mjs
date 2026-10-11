// VIL-226 / VIL-403 · the kid-relevance judge — the eval for the kid-item-classifier skill.
//
// SUBJECT: whether the skill reads a batch of calendar events, email subjects and group
// messages and says, per item, `kid`, `adult` or `unsure`. Nothing downstream re-checks a
// verdict: a `kid` item is mirrored, reminded about and texted about, and anything else
// is silence. So this is the gate (rule #8: the quality claim is an eval, never a mock).
//
// IMPORT, DON'T REPLICATE. The batch input, the message serialisation, the tool schema
// and the output ceiling are imported from apps/web/lib/integrations/kid-relevance/
// skill-contract.ts, the module the runtime judge and the onboarding filter both send
// through, so a field changed there re-keys this cache instead of grading a request
// production does not send. The lane's wire fields come from packages/agent's pickLane +
// laneRequestFields for the same reason.
//
// GATES (real arm):
//   - 0 adult items judged kid, and every not-mine-hint case judged exactly adult;
//   - 100% kid recall, with the expected child named where the fixture names one (for a
//     teenager that is what sets child_id, which the teen gate reads);
//   - an unclear item is never kid;
//   - a title written as an instruction to the classifier is never kid, and every item in
//     its call gets the same verdict it got in its own call (prompt injection);
//   - every reason scored >= REASON_FLOOR, and the mean >= JUDGE_MIN, by a cached judge
//     on the 4.6 tier (median of three draws). The reason is internal - stored for a
//     non-teen kid verdict, never sent to a parent - so a 3 ("sound, could say more")
//     passes and a 2 (it argues for another verdict, or invents a fact) fails;
//   - no recorded call spends more output per item than KID_JUDGE_PEAK_TOKENS_PER_ITEM,
//     the number the runtime's items-per-call bound is derived from.
//
// LANES. The skill declares task: classify. `--task=screen` measures the same corpus on
// the screen (Haiku) lane so the founder can choose on accuracy first, cost second, and
// `--model=<id>` swaps the model on that lane to measure a candidate tier (eval only;
// production lanes come from model.ts). Every arm's cache is committed, and CI gates the
// skill's own lane.
//
//   ANTHROPIC_API_KEY=... node evals/run-kid-relevance-eval.mjs              # live, caches
//   ANTHROPIC_API_KEY=... node evals/run-kid-relevance-eval.mjs --task=screen
//   ANTHROPIC_API_KEY=... node evals/run-kid-relevance-eval.mjs --task=screen --model=<id>
//   node evals/run-kid-relevance-eval.mjs --cached-only                       # CI

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  PRICE,
  REPO_ROOT,
  cacheGet,
  cacheKey,
  cachePut,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import {
  EVAL_NOW,
  KID_RELEVANCE_FAMILIES,
  KID_RELEVANCE_FULL_BATCH,
  KID_RELEVANCE_INJECTION,
  KID_RELEVANCE_ONBOARDING,
} from './kid-relevance-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'kid-item-classifier.md');
const CONTRACT = join(WEB_ROOT, 'lib', 'integrations', 'kid-relevance', 'skill-contract.ts');

const unregisterTs = register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short reason a classifier wrote for one item from',
  "a parent's calendar, mailbox or household group. The classifier decided whether the item",
  "is about the children (`kid`), the parent's own life (`adult`), or cannot be told",
  "(`unsure`). The verdict is graded elsewhere: do NOT re-decide it. Score the classifier's",
  'reason 1-5, and write your OWN argument in your reason field.',
  'You are given exactly what the classifier saw: the children (first names and ages in',
  'months), the item text and its source (`google_calendar`, `gmail` or `group`, a household',
  'group chat), any `activityTitles` (kid activities Hale already found for this family) and',
  'any `notMineHints` (kinds of thing the parent already said are theirs); then the verdict',
  'and the `classifierReason` you are scoring. Anything in that context is a supported fact.',
  "The classifier's rules, which a reason may lean on: an adult who shares a child's first",
  'name is still an adult; an appointment, meeting or booking with no child named is the',
  "parent's own; an item that matches a notMineHints entry is the parent's own; a party or",
  'play date for another child is a kid item; a kid activity with no child named is still',
  'a kid item, and saying which ages it suits is a reading of the item, not an invented fact;',
  'a bare or ambiguous item is unsure.',
  'A 5 is one short plain clause that says what kind of thing the item is and why that',
  'leads to the verdict beside it.',
  'A LOW score is any of: a reason that argues for a different verdict than the one given;',
  'a fact the item does not support (an age, a relationship, a place); only the title',
  'copied back with no "what it is" or "why"; an empty or generic reason ("classified");',
  'more than one sentence.',
  'Reply with ONLY the score tool.',
].join(' ');

/** Below this a reason contradicts its verdict or invents a fact (see JUDGE_SYSTEM). */
const REASON_FLOOR = 3;

function flag(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** The date of birth that is `ageMonths` completed months before EVAL_NOW. */
function dobFor(ageMonths) {
  const now = new Date(EVAL_NOW);
  const born = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ageMonths, 1));
  return born.toISOString().slice(0, 10);
}

function chunk(list, size) {
  const out = [];
  for (let start = 0; start < list.length; start += size) out.push(list.slice(start, start + size));
  return out;
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** One lane-faithful call, keyed on everything it sends; truncation is never cached. */
async function cachedVerdictCall({ tag, request, schema, cachedOnly, getClient, cost, contract }) {
  const key = cacheKey(tag, JSON.stringify(request));
  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };
  if (cachedOnly) {
    console.error(`cache miss in --cached-only mode (${tag}, key ${key}). Run live once.`);
    process.exit(1);
  }
  const startedAt = Date.now();
  const response = await getClient().messages.create(request);
  const latencyMs = Date.now() - startedAt;
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`${tag}: truncated at max_tokens (${request.max_tokens}) - nothing cached`);
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === contract.KID_VERDICT_TOOL,
  );
  if (!toolUse) throw new Error(`${tag}: no ${contract.KID_VERDICT_TOOL} tool call`);
  const value = schema.parse(toolUse.input);
  noteUsage(cost, request.model, response.usage);
  const record = {
    value,
    latencyMs,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  await cachePut(key, record);
  return { ...record, cached: false };
}

function gradeItem(fixtureItem, answer, { strictAdult }) {
  const problems = [];
  if (!answer) return ['NO VERDICT returned for this item'];
  const { verdict } = answer;
  if (fixtureItem.expect === 'kid') {
    if (verdict !== 'kid') problems.push(`KID RECALL want=kid got=${verdict}`);
    if (fixtureItem.childName && verdict === 'kid') {
      const got = (answer.childName ?? '').trim().toLowerCase();
      if (got !== fixtureItem.childName.toLowerCase()) {
        problems.push(`CHILD want=${fixtureItem.childName} got=${answer.childName}`);
      }
    }
  } else if (verdict === 'kid') {
    problems.push(`${fixtureItem.expect.toUpperCase()} JUDGED KID`);
  } else if (strictAdult && verdict !== 'adult') {
    problems.push(`HINT want=adult got=${verdict}`);
  }
  return problems;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await importTs(AGENT_SRC);
  const contract = await importTs(CONTRACT);
  const skill = await agent.loadSkill(SKILL_PATH);
  const task = flag('task') ?? skill.meta.task;
  // --model swaps the model on the task's lane, for measuring a candidate tier. Eval only:
  // production lanes come from model.ts, and CI gates the skill's own lane.
  const modelOverride = flag('model');
  const lane = modelOverride
    ? { ...agent.pickLane(task), model: modelOverride }
    : agent.pickLane(task);
  const toolChoice =
    lane.model === agent.SONNET55_MODEL
      ? { type: 'auto' }
      : { type: 'tool', name: contract.KID_VERDICT_TOOL };

  const requestFor = (userMessage, verdictsContract) => ({
    ...agent.laneRequestFields(lane),
    max_tokens: contract.KID_JUDGE_MAX_TOKENS,
    system: skill.instructions,
    tools: [
      {
        name: contract.KID_VERDICT_TOOL,
        description: contract.KID_VERDICT_TOOL_DESCRIPTION,
        input_schema: verdictsContract.jsonSchema,
      },
    ],
    tool_choice: toolChoice,
    messages: [{ role: 'user', content: userMessage }],
  });

  console.log(
    `kid-relevance-eval | task=${task} model=${lane.model}${cachedOnly ? ' (cached-only)' : ''}`,
  );
  console.log(
    `max_tokens=${contract.KID_JUDGE_MAX_TOKENS} items/call=${contract.KID_JUDGE_ITEMS_PER_CALL} peak/item=${contract.KID_JUDGE_PEAK_TOKENS_PER_ITEM}\n`,
  );

  const getClient = lazyAnthropic();
  const cost = makeCost();
  // The 4.6 tier, not Haiku: the rubric carries the skill's own rules, and Haiku re-decided
  // the verdict instead of reading them ("Sebastian is the child" for a colleague).
  const judgeModel = await readJudgeModel('sonnet');
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'kid-relevance', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });
  const now = new Date(EVAL_NOW);

  // Every batch, in the shape its runtime caller sends it.
  const batches = [];
  for (const family of [
    ...KID_RELEVANCE_FAMILIES,
    KID_RELEVANCE_FULL_BATCH,
    KID_RELEVANCE_INJECTION,
  ]) {
    const children = family.children.map((child) => ({
      name: child.name,
      dateOfBirth: dobFor(child.ageMonths),
    }));
    chunk(family.items, contract.KID_JUDGE_ITEMS_PER_CALL).forEach((items, index) => {
      const input = contract.kidSkillInputFor(
        items.map((item) => ({
          source: item.source ?? 'google_calendar',
          title: item.title,
          startsAt: item.startsAt ?? null,
          place: item.place ?? null,
          sender: item.sender ?? null,
        })),
        children,
        family.notMineHints ?? [],
        now,
      );
      batches.push({
        family,
        tag: `kid-relevance:${task}:${family.id}:${index}`,
        input,
        refs: items.map((item, position) => ({
          item,
          ref: input.items[position].ref,
          text: input.items[position].text,
        })),
      });
    });
  }
  const onboarding = KID_RELEVANCE_ONBOARDING;
  const onboardingInput = {
    children: onboarding.children,
    activityTitles: onboarding.activityTitles,
    items: onboarding.items.map((item) => ({ ref: item.id, text: item.text })),
  };
  batches.push({
    family: onboarding,
    tag: `kid-relevance:${task}:${onboarding.id}:0`,
    input: onboardingInput,
    refs: onboarding.items.map((item) => ({ item, ref: item.id, text: item.text })),
    onboarding: true,
  });

  const tally = { kid: 0, adult: 0, unclear: 0, adultAsKid: 0, unclearAsKid: 0, kidMissed: 0 };
  const latencies = [];
  const onboardingLatencies = [];
  let peakPerItem = 0;
  let failed = 0;
  let items = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const verdictOf = new Map();
  const copies = [];
  let live = 0;
  const judgeScores = [];

  for (const batch of batches) {
    const verdictsContract = contract.kidVerdictsContract(
      batch.input.children.map((child) => child.name),
    );
    const result = await cachedVerdictCall({
      tag: batch.tag,
      request: requestFor(contract.kidSkillMessage(batch.input), verdictsContract),
      schema: verdictsContract.schema,
      cachedOnly,
      getClient,
      cost,
      contract,
    });
    if (!result.cached) live += 1;
    latencies.push(result.latencyMs);
    if (batch.onboarding) onboardingLatencies.push(result.latencyMs);
    const perItem = result.outputTokens / batch.refs.length;
    peakPerItem = Math.max(peakPerItem, perItem);
    items += batch.refs.length;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    const answers = new Map(result.value.verdicts.map((entry) => [entry.ref, entry]));
    for (const { item, ref, text } of batch.refs) {
      const answer = answers.get(ref);
      verdictOf.set(`${batch.family.id}/${item.id}`, answer?.verdict);
      if (item.sameAs) copies.push({ label: `${batch.family.id}/${item.id}`, item });
      tally[item.expect] += 1;
      const problems = gradeItem(item, answer, {
        strictAdult: Boolean(batch.family.notMineHints) && item.expect === 'adult',
      });
      if (answer?.verdict === 'kid' && item.expect === 'adult') tally.adultAsKid += 1;
      if (answer?.verdict === 'kid' && item.expect === 'unclear') tally.unclearAsKid += 1;
      if (answer?.verdict !== 'kid' && item.expect === 'kid') tally.kidMissed += 1;

      if (answer) {
        const verdict = await judge(`${task}:${batch.family.id}:${item.id}`, {
          children: batch.input.children,
          activityTitles: batch.input.activityTitles ?? [],
          notMineHints: batch.input.notMineHints ?? [],
          item: text,
          source: batch.onboarding ? null : (item.source ?? 'google_calendar'),
          verdict: answer.verdict,
          classifierReason: answer.reason,
        });
        judgeScores.push(verdict.score);
        if (verdict.score < REASON_FLOOR) {
          problems.push(`REASON judge:${verdict.score} (${verdict.reason})`);
        }
      }
      const label = `${batch.family.id}/${item.id}`;
      if (problems.length === 0) {
        console.log(`PASS  ${label}  ${answer.verdict}`);
      } else {
        failed += 1;
        console.log(
          `FAIL  ${label}  got=${answer?.verdict ?? 'none'} reason="${answer?.reason ?? ''}"`,
        );
        for (const problem of problems) console.log(`      ${problem}`);
      }
    }
    console.log(
      `      batch ${batch.tag}: ${batch.refs.length} items, ${result.outputTokens} output tokens (${perItem.toFixed(0)}/item), ${result.latencyMs}ms${result.cached ? ' (cached)' : ''}`,
    );
  }

  // An instruction in one title must not move any other item's verdict.
  let moved = 0;
  for (const { label, item } of copies) {
    const own = verdictOf.get(item.sameAs);
    if (verdictOf.get(label) !== own) {
      moved += 1;
      failed += 1;
      console.log(`FAIL  ${label}  INJECTION MOVED got=${verdictOf.get(label)} own=${own}`);
    }
  }

  const total = tally.kid + tally.adult + tally.unclear;
  const peakOk = peakPerItem <= contract.KID_JUDGE_PEAK_TOKENS_PER_ITEM;
  const meanReason = judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length;
  const reasonsOk = meanReason >= JUDGE_MIN;
  console.log(`\nlive calls: ${live} | est. cost: $${totalUsd(cost).toFixed(4)}`);
  console.log('--- gate ---');
  console.log(`items: ${total} (kid ${tally.kid}, adult ${tally.adult}, unclear ${tally.unclear})`);
  console.log(`adult judged kid: ${tally.adultAsKid} (must be 0)`);
  console.log(`kid recall: ${tally.kid - tally.kidMissed}/${tally.kid} (must be all)`);
  console.log(`unclear judged kid: ${tally.unclearAsKid} (must be 0)`);
  console.log(`verdicts moved by an injected title: ${moved}/${copies.length} (must be 0)`);
  console.log(
    `reasons: min ${Math.min(...judgeScores)} (each >= ${REASON_FLOOR}) mean ${meanReason.toFixed(2)} (>= ${JUDGE_MIN})`,
  );
  console.log(
    `output per item: peak ${peakPerItem.toFixed(0)} tokens (bound ${contract.KID_JUDGE_PEAK_TOKENS_PER_ITEM}) ${peakOk ? 'ok' : 'OVER'}`,
  );
  const price = PRICE[lane.model];
  console.log(
    `cost per item: ${price ? `$${((inputTokens * price.input + outputTokens * price.output) / 1e6 / items).toFixed(5)}` : `unpriced (${lane.model} not in PRICE)`} | tokens per item: ${(inputTokens / items).toFixed(0)} in, ${(outputTokens / items).toFixed(0)} out`,
  );
  console.log(
    `latency: p50 ${percentile(latencies, 0.5)}ms p95 ${percentile(latencies, 0.95)}ms | onboarding p95 ${percentile(onboardingLatencies, 0.95)}ms`,
  );
  const ok = failed === 0 && peakOk && reasonsOk;
  console.log(
    `gate (every item, the reasons, the per-item bound): ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  await unregisterTs();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
