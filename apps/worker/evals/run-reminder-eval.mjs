// The reminder · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/reminder.md) over the REAL facts
// and gates: `reminderFacts`, `reminderUserMessage` and `reminderRefusals` are imported
// from apps/web/lib/loop/reminders/compose.ts. The model writes the WHOLE text; a judge
// scores facts (including a fact check on logistics such as departure or travel time),
// AM/PM, language, never claiming free time over a timed event, and tone.
// Nothing matches words.
//
// Recorded 2026-10-27 (8/8, ledger 914-evals; every --broken case fails, incl. an added wish and one unnatural-but-factual reply per language). CI replays it cached-only:
//   node evals/run-reminder-eval.mjs --max-usd <ledger total + allowance>   # live, then caches
//   node evals/run-reminder-eval.mjs --broken                               # calibration: must FAIL
//   node evals/run-reminder-eval.mjs --cached-only                          # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
  GENERAL_REFERENCE_TEXTS,
  JUDGE_MIN,
  cachedToolCall,
  formatDraws,
  installEvalSpendCap,
  isDryRun,
  isMain,
  lazyAnthropic,
  makeCost,
  makeJudge,
  summarizeDryPlan,
  totalUsd,
} from './lib/harness.mjs';
import { reminderJudgeModel } from './lib/reminder-judge-model.mjs';
import { REMINDER_FIXTURES } from './reminder-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reminder.md');
const COMPOSE_SRC = join(WEB_ROOT, 'lib', 'loop', 'reminders', 'compose.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reminder text Hale sends a parent about what is on',
  'their calendar. The model wrote the whole text; nothing is added around it. You are given',
  'the facts (offset, now, events with date, allDay, start, end, location; planLink; language),',
  'the text and watchFor notes. Score 1-5 on FACTS, LANGUAGE and TONE, not wording.',
  'planLink is OPTIONAL: the writer may include it or leave it out. Its absence is never a',
  'fault and never lowers the score; only a link other than planLink is.',
  'A 5: every event is there with its facts as given and nothing invented; each time given is',
  'correct INCLUDING morning versus afternoon or evening (AM/PM or the natural equivalent in',
  'that language); no clock time for an all-day event; the day phrased truly from now (tomorrow',
  'versus today); entirely in the requested language; short, calm, warm, like a friend.',
  'A LOW score (1-2) is any of: implying the family has nothing to be at, or that the day is',
  'open, free, quiet, a break or breathing room, when ANY event has a start time, whatever its',
  'title says (naming an all-day item as what the day is, such as a PD day or day off, is a',
  'true fact and fine, as long as the timed events are also clearly there); a wrong or',
  'ambiguous AM/PM; a wrong time, date, or place; an invented detail (what to bring, who is',
  'going, how it will go); guessing what a generic "an appointment" is; the wrong language or',
  'mixed languages; a link other than planLink; hype, exclamation marks, emoji, a question or',
  'asking them to reply with a word.',
  'FACT CHECK every logistics claim against the facts you are given: when to leave or set',
  'off, how long getting there takes, traffic, parking, arrival or pickup times, and any',
  'other timing or travel detail. If the facts do not contain it (there is never a travel',
  'time or departure time in these facts), stating it as fact is an invented detail and a',
  'LOW score (1-2), in any language, however it is phrased. Saying how far away the event',
  'is from now (in about an hour, tomorrow afternoon) is a true fact from now and start, and',
  'fine; turning that into when to leave is not.',
  'JUDGE WHAT EACH SENTENCE DOES, not its words: the text is only there to tell the parent',
  'what is on the calendar. Any sentence whose job is something else that nobody asked for,',
  'such as a wish, hope or blessing for them, advice or a suggestion on what to do or how to',
  'plan, or a comment or opinion about the day or the family, is unrequested filler. It is',
  `not a fact from the facts you are given, so it caps the score at ${JUDGE_MIN - 1} at most, in`,
  'any language and however it is phrased, even when every fact is right.',
  'NATIVE SPEAKER CHECK, on the WHOLE text: read it as a native speaker of its language',
  'receiving it from a friend. Would a native speaker text exactly this, as written? Clumsy',
  'or unidiomatic phrasing, wrong grammar, a missing or wrong article or particle, a calque',
  'or word-for-word translation, an unnatural way of saying a time range or a day, or a',
  'title dropped in where the sentence does not flow, makes it NOT natural. Judge the reply',
  'as a whole by how it reads, never against a list of phrases. Do it this way: first say to',
  'yourself how a native speaker would text these same facts; then compare. If the text differs',
  'from that in grammar, idiom or construction (not just in word choice or order a native would',
  'also use), it is not natural, however close it is and however small the slip. If a native speaker would',
  `not send it as written, it caps the score at ${JUDGE_MIN - 1} at most, in any language, even when`,
  'every fact is right; say what reads unnaturally in the reason.',
  'NOTHING GIVEN MAY BE LEFT OUT: check every date, start and end in the facts against the',
  "text. Each event's day (said truly from now, such as tomorrow or today, or as a date), its",
  'start time and, when the facts give one, its end time must all be in the text, in any natural',
  'form for the language. A text that drops any one of them, such as giving only the start when',
  'an end is given, leaves out a fact the parent needs: that is a fact failure and a LOW score',
  '(1-2), however natural the rest reads. Name in the reason which time or date is missing.',
  "KEEP EACH TITLE AS THE EVENT'S NAME: the title is what the event is called, not a",
  'statement about the day or the family. Turning a title into a claim it does not make, such',
  'as recasting it as what the day is, what is closed, or what the event involves, changes a',
  'fact: that is a fact failure and a LOW score (1-2), in any language, even when every time',
  'and place is right. Keeping the name never excuses grammar: the title still needs the',
  'article, quotation or connecting words a native speaker would give a named event, and a',
  'bare title dropped into a sentence where it does not fit still fails the native speaker',
  'check. Changing what the title says is a fact failure; say in the reason how it changed.',
  'NO UNSTATED INFERENCES: state only what the facts say. A consequence the text draws from a',
  'title or from the facts (what is closed or open, who is affected, why it is happening, what',
  'it means for the family) is not in the facts, even when it is likely: stating it as fact is a',
  'fact failure and a LOW score (1-2), in any language, however it is phrased.',
  'NO CALENDAR TALK: the parent knows they have a calendar. A sentence that explains how the',
  'event is stored or classified (that it is on the calendar, timed, all-day, an entry) instead',
  'of telling them what is on is unrequested filler and caps the score at',
  `${JUDGE_MIN - 1} at most, in any language and however it is phrased.`,
  'TEXTS LIKE A FRIEND, NOT A NOTIFICATION: on top of grammar, ask whether a friend who knows',
  'the family would text it this way. A reply that reads like a system notification or a',
  'calendar readout rather than a person is correct but not how a friend texts. Judge the',
  'whole reply by its meaning and register, never by whether it uses or avoids any particular',
  'phrase, construction or opener. Do it this way: first picture the',
  'same facts as a quick, warm text from a friend; then ask whether this reply sounds like that',
  'or like an automated alert that only states the entry and its times. Correct and polite is',
  'not enough: if it sounds like the alert, it fails this check. It caps the score at',
  `${JUDGE_MIN - 1} at most, in any language, even when every fact is right; say why in the reason.`,
  'CAPS ARE CEILINGS: complete, correct facts never lift a capped score. If your reason names',
  'any phrasing a native speaker would write differently, the score is at most',
  `${JUDGE_MIN - 1}, however minor you think it is.`,
  'Reply with ONLY the score tool.',
].join(' ');

// Reminder-specific scored references, on top of the shared general set.
const REMINDER_REFERENCE_TEXTS = [
  {
    facts:
      'Event "Parent & Tot Skate", Tuesday Oct 27, 10:30 AM. Now: Monday evening. Language: English.',
    text: 'Parent & Tot Skate is tomorrow morning at 10:30.',
    score: 5,
    why: "The same skate as Barton's prod sample, said the way a friend would: when, from now, and the time. Nothing invented.",
  },
  {
    facts: 'Event "Soccer", tomorrow 5:30-6:30 PM. Language: Chinese.',
    text: '明天下午5点半到6点半有足球训练。',
    score: 5,
    why: '足球训练 is the normal way to say a kids\' "Soccer" session in Chinese. It is a natural rendering of the title, NOT a changed title or a fact failure.',
  },
];

// Deterministic broken stand-in: the prod bug itself — a code-built prefix, a time with
// no meridiem, a free-day claim over a timed event, English for a French parent.
/**
 * The judge's output cap (914). Sized from the longest verdict in this suite's saved judge
 * cache (Haiku and Sonnet, the 280 verdicts the 914 branch recorded): 244 tokens
 * (@anthropic-ai/tokenizer, legacy count; median 97, p95 172). 512 is about 2x that, room
 * for a newer tokenizer and the tool-call wrapper. A verdict that still hits it is a judge
 * error that stops the run (makeJudge), never a pass.
 */
export const REMINDER_JUDGE_MAX_OUTPUT_TOKENS = 512;

const BROKEN =
  "Mon, Oct 26: Jour de congé at 3:00 Tomorrow's a day off, so you've got a bit of breathing room.";

// Targeted broken cases: each is a believable reply with one defect the judge must catch.
// The facts are right; one thing is wrong (an unrequested wish, unnatural phrasing, or a
// given time left out).
export const BROKEN_CASES = [
  {
    fixtureId: 'en-pd-day-all-day',
    tag: 'en-pd-day-all-day:added-wish',
    body: 'Tomorrow is a PD Day, so there is no school. Hope you can plan around it.',
  },
  // Clumsy-but-factual, one per fixture language: every fact is right, but no native
  // speaker would text it as written. The judge must fail each on naturalness alone.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:unnatural',
    body: "Demain, lundi 26 octobre, à 15 h jusqu'à 16 h, il y a Jour de congé à la bibliothèque de Georgetown.",
  },
  // Omitted fact: natural French with every fact right except the end time, which is
  // dropped. The judge must fail it on the missing time alone.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:omits-end',
    body: 'Demain à 15 h, tu as « Jour de congé » à la bibliothèque de Georgetown.',
  },
  // Reinterpreted title: Sloane-failed recorded sample. "un jour de congé" turns the event's
  // name into a claim that the day is a day off; the judge must fail it on that alone.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:reinterprets-title',
    body: "Rappel : demain à 15 h, il y a un jour de congé à la bibliothèque de Georgetown, jusqu'à 16 h.",
  },
  // Calendar metadata explained back to the parent (recorded en-pd-day-timed reply).
  {
    fixtureId: 'en-pd-day-timed',
    tag: 'en-pd-day-timed:calendar-talk',
    body: "Tomorrow there's a PD Day from 9:30 AM to 12:00 PM at the Northside community centre. It's on the calendar as a timed event, so you'll want to plan around it.",
  },
  // Unstated inference: the facts say only "PD Day", all day; school closure is inferred.
  {
    fixtureId: 'en-pd-day-all-day',
    tag: 'en-pd-day-all-day:inferred-closure',
    body: 'Tomorrow is a PD Day, so school is closed for students.',
  },
  {
    fixtureId: 'en-pd-day-all-day',
    tag: 'en-pd-day-all-day:unnatural',
    body: 'Tomorrow, it is having PD Day the whole of day, school is not.',
  },
  {
    fixtureId: 'zh-hour-out',
    tag: 'zh-hour-out:unnatural',
    body: '在大约一个小时以后，从晚上7点到8点，有钢琴课它是在Ms. Chen studio。',
  },
  // Title set after a colon as a label: recorded fr reply Sloane failed. Reads as a
  // statement that the day is a day off, not as the event's name.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:colon-label',
    body: 'Demain, lundi 26 octobre, à 15 h 00 à la bibliothèque de Georgetown : jour de congé. Ça se termine à 16 h 00.',
  },
  // Notification-style but factually correct (Sloane's samples, recorded replies): a
  // friend would not text these. The judge must cap each on naturalness alone.
  {
    fixtureId: 'en-late-same-day',
    tag: 'en-late-same-day:notification',
    body: 'Swim class is today at 10:00 AM, running until 11:00 AM.',
  },
  {
    fixtureId: 'en-teen-generic',
    tag: 'en-teen-generic:notification',
    body: 'Tomorrow you have an appointment from 4:45 to 5:45 PM.',
  },
  // Storytime calendar readout (the pattern of Barton's prod Storytime sample) on the real
  // zh facts: every fact right, but an entry list, not a text from a friend.
  {
    fixtureId: 'zh-evening-with-plan',
    tag: 'zh-evening-with-plan:storytime-readout',
    body: 'Library story time：10月26日 上午11:00。Soccer：10月26日 下午5:30-6:30。',
  },
  // Barton's prod text. No fixture has these facts; it rides on en-late-same-day, so it
  // also fails on facts. Kept as the bar's reference sample.
  {
    fixtureId: 'en-late-same-day',
    tag: 'en-late-same-day:prod-notification',
    body: 'Parent & Tot Skate on Tuesday, Oct 27 at 10:30 a.m.',
  },
];

/**
 * The --broken footer. Calibration holds only if EVERY broken case fails; normal cases
 * (real replies, as in --broken --rescore) are meant to PASS and are reported on their own
 * line, never counted as a broken case that slipped through. Exit ok needs both.
 * @param {{ fixture: { id: string }, failures: string[], kind: 'normal' | 'broken' }[]} results
 */
export function brokenFooter(results) {
  const brokenCases = results.filter((r) => r.kind === 'broken');
  const normal = results.filter((r) => r.kind === 'normal');
  const slipped = brokenCases.filter((r) => r.failures.length === 0).map((r) => r.fixture.id);
  const normalFailed = normal.filter((r) => r.failures.length > 0).map((r) => r.fixture.id);
  const calibrated = slipped.length === 0;
  const lines = [
    `broken-mode calibration (${brokenCases.length} broken cases, every one must fail): ${calibrated ? 'PASS' : `FAIL (passed: ${slipped.join(', ')})`}`,
  ];
  if (normal.length > 0)
    lines.push(
      `normal cases (${normal.length}, every one must pass): ${normalFailed.length === 0 ? 'PASS' : `FAIL (failed: ${normalFailed.join(', ')})`}`,
    );
  return { ok: calibrated && normalFailed.length === 0, calibrated, slipped, normalFailed, lines };
}

/** The --dry listing: every compose and judge call, then subtotals and a grand total. */
export function dryPlanLines(plans, { spentUsd, capUsd }) {
  const lines = [];
  const row = (kind, p) =>
    p.cached
      ? `DRY  ${kind.padEnd(7)} cached    ${p.tag}${p.score !== undefined ? `  score ${p.score}` : ''}`
      : `DRY  ${kind.padEnd(7)} uncached  ${p.tag}  ~${p.inputTokens} in (~${p.cacheReadTokens ?? 0} at cache-read) + ${p.maxTokens} max out  worst $${p.worstUsd.toFixed(5)}`;
  for (const p of plans.compose ?? []) lines.push(row('compose', p));
  for (const p of plans.judge ?? []) lines.push(row('judge', p));
  const s = summarizeDryPlan(plans, { spentUsd, capUsd });
  const sub = (name, x) =>
    `DRY ${name} | calls ${x.calls} (cached ${x.cached}, uncached ${x.uncached}) | worst $${x.worstUsd.toFixed(5)}`;
  lines.push(sub('compose', s.compose));
  lines.push(sub('judge  ', s.judge));
  lines.push(
    `DRY total | worst $${s.worstTotalUsd.toFixed(5)} | ledger $${spentUsd.toFixed(5)} -> projected $${s.projectedLedgerUsd.toFixed(5)} vs cap $${capUsd} | ${s.fitsCap ? 'FITS' : 'EXCEEDS CAP'}`,
  );
  lines.push(
    'DRY: input tokens are a rough offline estimate (1 per 3 bytes, not a bound; the live guard counts with countTokens); the first uncached call of each kind writes its prompt cache, later ones read it; an uncached reply is priced as a max-length stand-in for its judge; live calls: 0',
  );
  return lines;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('reminder');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const compose = await importTs(COMPOSE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  // Re-score only: replies come from the cache (a miss is an error, never a live compose);
  // only the judge runs live.
  const rescore = process.argv.includes('--rescore');
  // The shared judge (Sloane, 2026-10-27): agent.SONNET_MODEL, lowest of 3, references.
  // REMINDER_JUDGE_MODEL overrides for a comparison run.
  const judgeModel = reminderJudgeModel(process.env, agent);
  // --only a,b: run just these fixture ids / broken-case tags (minimum calibration set).
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
  const wanted = (id) => !only || only.has(id);
  // Three draws per reply, keep the LOWEST: an inconsistent judge shows up as a fail
  // instead of a lucky pass slipping through.
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'reminder', cachedOnly, getClient, cost, {
    samples: 3,
    aggregate: 'min',
    references: [...GENERAL_REFERENCE_TEXTS, ...REMINDER_REFERENCE_TEXTS],
    logCost: true,
    maxOutputTokens: REMINDER_JUDGE_MAX_OUTPUT_TOKENS,
  });
  const dry = isDryRun();
  // --dry: compose (subject-model) calls are projected into this plan, never made.
  const composePlan = [];

  console.log(
    `reminder eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of REMINDER_FIXTURES) {
    if (!wanted(fixture.id)) continue;
    const facts = compose.reminderFacts({ ...fixture.args, now: new Date(fixture.args.now) });
    const userMessage = compose.reminderUserMessage(facts);
    const body =
      broken && !rescore
        ? BROKEN
        : String(
            (
              await cachedToolCall({
                tag: `reminder:${fixture.id}`,
                model,
                lane,
                system: skill.instructions,
                userMessage,
                toolName: 'reminder_text',
                toolSchema: TOOL_SCHEMA,
                toolDescription: 'The one text Hale sends the parent.',
                maxTokens: 300,
                cachedOnly: cachedOnly || rescore,
                dryPlan: dry ? composePlan : undefined,
                getClient,
                cost,
              })
            ).value.text ?? '',
          ).trim();
    const failures = compose.reminderRefusals(body, facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    // A real reply (normal run, or --broken --rescore) is meant to PASS; only the
    // deterministic stand-in body is meant to fail.
    results.push({
      fixture,
      body,
      failures,
      scores: verdict.samples,
      draws: verdict.draws,
      kind: broken && !rescore ? 'broken' : 'normal',
    });
  }
  if (broken) {
    for (const bc of BROKEN_CASES) {
      if (!wanted(bc.tag)) continue;
      const fixture = REMINDER_FIXTURES.find((f) => f.id === bc.fixtureId);
      if (!fixture) throw new Error(`broken case ${bc.tag}: no fixture ${bc.fixtureId}`);
      const facts = compose.reminderFacts({ ...fixture.args, now: new Date(fixture.args.now) });
      const userMessage = compose.reminderUserMessage(facts);
      const failures = compose.reminderRefusals(bc.body, facts).map((r) => `unsendable:${r}`);
      const verdict = await judge(bc.tag, {
        input: userMessage,
        text: bc.body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
      results.push({
        fixture: { ...fixture, id: bc.tag },
        body: bc.body,
        failures,
        scores: verdict.samples,
        draws: verdict.draws,
        kind: 'broken',
      });
    }
  }
  if (dry) {
    // --dry: list every draw and the guard's worst case, then exit. No network was used.
    const capUsd = readCapUsd();
    if (capUsd === null)
      throw new Error('eval --dry: no --max-usd / HALE_MAX_USD; nothing to project against');
    const { spentUsd } = readLedger();
    for (const line of dryPlanLines(
      { compose: composePlan, judge: judge.plan },
      { spentUsd, capUsd },
    ))
      console.log(line);
    const s = summarizeDryPlan({ compose: composePlan, judge: judge.plan }, { spentUsd, capUsd });
    process.exit(s.fitsCap ? 0 : 3);
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(30)} "${r.body}"`,
    );
    console.log(
      `      · scores [${(r.scores ?? []).join(', ')}] min ${Math.min(...(r.scores ?? [Number.NaN]))}`,
    );
    for (const d of formatDraws(r.draws)) console.log(`      · ${d}`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  const footer = brokenFooter(results);
  for (const line of footer.lines) console.log(line);
  process.exit(footer.ok ? 0 : 1);
}

// Importing this file (a test, a load check) must never run the eval.
if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('reminder eval harness error:', err);
    process.exit(2);
  });
}
