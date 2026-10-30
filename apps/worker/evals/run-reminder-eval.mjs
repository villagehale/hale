// The reminder · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/reminder.md) over the REAL facts
// and gates: `reminderFacts`, `reminderUserMessage` and `reminderRefusals` are imported
// from apps/web/lib/loop/reminders/compose.ts. The model writes the WHOLE text; a judge
// scores FACTS only (including a fact check on logistics such as departure or travel
// time, AM/PM, language, and never claiming free time over a timed event). Phrasing,
// sentence shape, an untranslated place name, and a title quoted as-is are not faults.
// Nothing matches words.
//
// Recorded 2026-10-27 (8/8, ledger 914-evals). CI replays it cached-only:
//   node evals/run-reminder-eval.mjs --max-usd <ledger total + allowance>   # live, then caches
//   node evals/run-reminder-eval.mjs --broken                               # calibration: must FAIL
//   node evals/run-reminder-eval.mjs --cached-only                          # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
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

// Mirrors compose.ts (VIL-467): the model returns the texts it chose to send, in order.
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'The texts Hale sends the parent, in order. One or more.',
    },
    bold: {
      type: 'string',
      description:
        'Optional. The exact words, copied from one of your texts, to show in bold. Leave it out for none.',
    },
  },
  required: ['texts'],
};

/** VIL-474 · the words the writer chose to bold, trimmed, or null. */
export function readBold(value) {
  const b = typeof value?.bold === 'string' ? value.bold.trim() : '';
  return b === '' ? null : b;
}

/** The [bold] line the judge reads after the texts. Words the code would not find in
 * the texts are sent undecorated, so the judge sees "none" for them too. */
export function boldLine(texts, bold) {
  if (!bold || !texts.some((t) => t.includes(bold))) return '[bold] none';
  return `[bold] "${bold}"`;
}

/** The model's texts, trimmed. The judge reads them in order, one per line. */
export function readTexts(value) {
  const texts = Array.isArray(value?.texts) ? value.texts : [];
  return texts.map((t) => String(t ?? '').trim());
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reminder text Hale sends a parent about what is on',
  'their calendar. The model wrote the whole text; nothing is added around it. You are given',
  'the facts (offset, now, events with date, allDay, start, end, location; planLink; language),',
  'the text and watchFor notes. Score 1-5 on FACTS only: whether every event keeps the facts',
  'it was given, and whether anything was invented. Do not score phrasing, sentence shape,',
  'register, whether a place name is translated or left as given, or whether a title is quoted',
  'as-is, woven in, or left bare.',
  'planLink is OPTIONAL: the writer may include it or leave it out. Its absence is never a',
  'fault and never lowers the score; only a link other than planLink is.',
  'A 5: every event is there with every fact it was given — its day (said truly from now),',
  'its start, and when given its end (as a clock time or as a duration from the start), its',
  'venue name and its address, and who it is for — and nothing invented; each time given is',
  'correct INCLUDING morning versus afternoon or evening (AM/PM or the natural equivalent in',
  'that language); no clock time for an all-day event; entirely in the requested language.',
  'A LOW score (1-2) is any of: a missing or vague start, end, venue name, or address that',
  'the facts gave; an invented end or duration when the facts gave none; implying the family',
  'has nothing to be at, or that the day is open, free,',
  'quiet, a break or breathing room, when ANY event has a start time, whatever its title',
  'says (naming an all-day item as what the day is, such as a PD day or day off, is a true',
  'fact and fine, as long as the timed events are also clearly there); a wrong or ambiguous',
  'AM/PM; a wrong time, date, or place; an invented detail (what to bring, who is going, how',
  'it will go); guessing what a generic "an appointment" is; the wrong language or mixed',
  'languages; a link other than planLink.',
  'FACT CHECK every logistics claim against the facts you are given: when to leave or set',
  'off, how long getting there takes, traffic, parking, arrival or pickup times, and any',
  'other timing or travel detail. If the facts do not contain it (there is never a travel',
  'time or departure time in these facts), stating it as fact is an invented detail and a',
  'LOW score (1-2), in any language, however it is phrased. Saying how far away the event',
  'is from now (in about an hour, tomorrow afternoon) is a true fact from now and start, and',
  'fine; turning that into when to leave is not.',
  'NOTHING GIVEN MAY BE LEFT OUT: check every date, start, end, venue name and address in',
  "the facts against the text. Each event's day (said truly from now, such as tomorrow or",
  'today, or as a date), its start time and, when the facts give one, its end (as a clock',
  'time or as a duration from the start), its venue name and its street address must all be',
  'in the text, in any natural form for the language. When the facts give no end, inventing',
  'one is a fact failure and a LOW score (1-2). A text that drops any given fact, such as',
  'giving only the start when an end is given, or a venue name with no address when an',
  'address was given, leaves out a fact the parent needs: that is a fact failure and a LOW',
  'score (1-2), however the rest reads. Name in the reason which fact is missing.',
  "KEEP EACH TITLE AS THE EVENT'S NAME: the title is what the event is called, not a",
  'statement about the day or the family. Turning a title into a claim it does not make, such',
  'as recasting it as what the day is, what is closed, or what the event involves, changes a',
  'fact: that is a fact failure and a LOW score (1-2), in any language, even when every time',
  'and place is right. Quoting the title as-is, leaving it bare, or weaving it into a sentence',
  'are all fine as long as what the title means is unchanged. Changing what the title says is',
  'a fact failure; say in the reason how it changed.',
  'Judge the title by MEANING, not wording: first say what the title names in the facts, then',
  'what the text presents it as. Translating, rewording, or changing case or quotes is fine',
  'when the text still presents it as the name of that event. Words that match the title are',
  'not enough: when the text no longer uses it as the name of the event but as a plain',
  'description of what is happening or what the day is, the meaning changed even if every word',
  'is the same, and that is a LOW score (1-2).',
  'NO UNSTATED INFERENCES: state only what the facts say. A consequence the text draws from a',
  'title or from the facts (what is closed or open, who is affected, why it is happening, what',
  'it means for the family) is not in the facts, even when it is likely: stating it as fact is a',
  'fact failure and a LOW score (1-2), in any language, however it is phrased.',
  'Do not lower the score for how the sentence is shaped, whether it reads like a list or a',
  'notification, whether a generic place word stayed in the source language, or whether the',
  'title is quoted or bare. Those are not fact failures.',
  'The text arrives as one or more numbered texts ([text 1], [text 2]...) sent in that order;',
  'read them together as one reminder.',
  'BOLD CHECK (VIL-474), always: the last line is [bold] with the words the writer chose to',
  'show in bold, or "none". Bold is meant for, at most, one fact the parent might have to',
  'act on and would cost them if skimmed; most reminders should have none. A [bold] of none',
  'is always fine. Bold on something that does not stand out as a fact to act on (a',
  'greeting, a title, the day of a routine event, a whole sentence, or several facts at once)',
  'scores at most 3 even with every fact right. Say in the reason what was bolded and why it',
  'does or does not fit.',
  'CHANGED FACT: when an event in the facts has `changed` (which of time, date or venue, and',
  'its old value `from`), the text must tell the new value and make clear it changed; leaving',
  'out that it changed, or presenting the old value as current, is a fact failure and a LOW',
  'score (1-2). On such an event, bold on its new value is exactly what bold is for and fits;',
  'with no bold at all, the score is at most 3.',
  'VOICE CHECK, ONLY when watchFor asks for it: then also judge, by meaning, whether the',
  'texts read like a person texting or like a form filled in, such as every event poured',
  'into the same sentence frame with only the facts swapped, or several events packed into',
  'one long block. A text that reads like a filled-in frame or one long block scores at most',
  '3 even with every fact right. With no VOICE CHECK in watchFor, phrasing is never scored.',
  'Reply with ONLY the score tool.',
].join(' ');

// Reminder-specific scored references. Facts only: a list shape or an untranslated
// place name still scores 5 when every given fact is there.
const REMINDER_REFERENCE_TEXTS = [
  {
    facts:
      'Event "Parent & Tot Skate", Tuesday Oct 27, 10:30 AM. Now: Monday evening. Language: English.',
    text: 'Parent & Tot Skate is tomorrow morning at 10:30.',
    score: 5,
    why: 'Every fact given is there: the event, the day from now, and the time. Nothing invented.',
  },
  {
    facts: 'Event "Soccer", tomorrow 5:30-6:30 PM. Language: Chinese.',
    text: '明天下午5点半到6点半有足球训练。',
    score: 5,
    why: '足球训练 keeps the meaning of the title "Soccer". That is not a changed title or a fact failure.',
  },
  {
    facts: 'Event "Soccer", tomorrow 5:30-6:30 PM. Language: English.',
    text: 'Soccer is tomorrow at 5:30, about an hour.',
    score: 5,
    why: 'The given end is there as a duration from the start. That is not a missing end.',
  },
  {
    facts:
      'Event "Jour de congé", tomorrow 3:00-4:00 PM at Georgetown library, 9 Church St. Language: French.',
    text: 'Demain, lundi, "Jour de congé" de 15 h à 16 h à Georgetown library, 9 Church St.',
    score: 5,
    why: 'Every given fact is there. The title is quoted as-is and the place name is left untranslated. Those are not fact failures.',
  },
  {
    facts:
      'Event "Soccer", tomorrow 5:30-6:30 PM at Riverside Field, 22 Park Rd. Language: Chinese.',
    text: '明天下午5点半到6点半有足球训练。',
    score: 2,
    why: 'The time is right but the venue name and address were given and are missing. That is a fact failure.',
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

// Targeted broken cases: each is a believable reply with one FACT defect the judge
// must catch (a given time, venue or address left out; a title turned into a claim;
// an inferred consequence; the wrong event). Style-only replies are not listed.
export const BROKEN_CASES = [
  // Omitted fact: every fact right except the end time, which is dropped.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:omits-end',
    body: 'Demain à 15 h, tu as « Jour de congé » à Georgetown library, 9 Church St.',
  },
  // Venue given, street address dropped.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:omits-address',
    body: "Demain à 15 h, tu as « Jour de congé » à Georgetown library jusqu'à 16 h.",
  },
  // Reinterpreted title: "un jour de congé" turns the event's name into a claim that
  // the day is a day off; the judge must fail it on that alone.
  {
    fixtureId: 'fr-jour-de-conge-timed',
    tag: 'fr-jour-de-conge-timed:reinterprets-title',
    body: "Rappel : demain à 15 h, il y a un jour de congé à Georgetown library, 9 Church St, jusqu'à 16 h.",
  },
  // Unstated inference: the facts say only "PD Day", all day; school closure is inferred.
  {
    fixtureId: 'en-pd-day-all-day',
    tag: 'en-pd-day-all-day:inferred-closure',
    body: 'Tomorrow is a PD Day, so school is closed for students.',
  },
  // Both events, neither venue nor address (the zh prod miss).
  {
    fixtureId: 'zh-evening-with-plan',
    tag: 'zh-evening-with-plan:omits-place',
    body: 'Library story time：10月26日 上午11:00。Soccer：10月26日 下午5:30-6:30。',
  },
  // Barton's prod text. No fixture has these facts; it rides on en-late-same-day, so it
  // fails on facts. Kept as the bar's reference sample.
  {
    fixtureId: 'en-late-same-day',
    tag: 'en-late-same-day:prod-notification',
    body: 'Parent & Tot Skate on Tuesday, Oct 27 at 10:30 a.m.',
  },
  // VIL-474 · every fact right, but the bold lands on a routine greeting rather than a
  // fact the parent might act on. Must fail on the bold alone.
  {
    fixtureId: 'en-bold-routine-single',
    tag: 'en-bold-routine-single:bold-on-greeting',
    body: 'hey, heads up for tomorrow\nParent & Tot Skate is at 10:30 to 11:20 AM at Mold-Masters SportsPlex, 221 Guelph St',
    bold: 'hey, heads up for tomorrow',
  },
  // VIL-467 facts guardrail: every fact right except storytime's place, which is vague
  // ("the library", no branch or address). Must fail on that alone.
  {
    fixtureId: 'en-next-day-multi-event',
    tag: 'en-next-day-multi-event:vague-place',
    body: [
      'hey, heads up for tomorrow',
      "Theo's Montessori tour is at 10 at Little Oaks Montessori, 41 Mill St, about an hour",
      'then storytime for Léa at the library, 1:30 to 2:15',
    ].join('\n'),
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

/**
 * Cached-only expected-fail list (VIL-467, https://linear.app/villagehale/issue/VIL-467).
 * Sloane's design call on #914: the judge is right on these four; the fix belongs in the
 * writer (coach-skill batch), not the judge. They must pass before launch. The batch
 * removes an id here once its reply passes; a listed case that passes turns the check red
 * so the list can never go stale.
 */
export const EXPECTED_FAIL = Object.freeze([]);

/**
 * The real-mode gate. Every case must pass except the ones on `expectedFail`, which must
 * still fail. A listed id with no matching case is also an error (renamed or removed fixture).
 * @param {{ fixture: { id: string }, failures: string[] }[]} results
 * @param {readonly string[]} expectedFail
 */
export function expectedFailGate(results, expectedFail) {
  const listed = new Set(expectedFail);
  const ids = new Set(results.map((r) => r.fixture.id));
  const unexpectedFail = results
    .filter((r) => r.failures.length > 0 && !listed.has(r.fixture.id))
    .map((r) => r.fixture.id);
  const unexpectedPass = results
    .filter((r) => r.failures.length === 0 && listed.has(r.fixture.id))
    .map((r) => r.fixture.id);
  const unknown = expectedFail.filter((id) => !ids.has(id));
  const expectedFailed = results
    .filter((r) => r.failures.length > 0 && listed.has(r.fixture.id))
    .map((r) => r.fixture.id);
  const lines = [];
  if (expectedFailed.length > 0)
    lines.push(`expected-fail (VIL-467, still failing as listed): ${expectedFailed.join(', ')}`);
  if (unexpectedFail.length > 0)
    lines.push(`FAIL unexpected failures: ${unexpectedFail.join(', ')}`);
  if (unexpectedPass.length > 0)
    lines.push(
      `FAIL expected-fail case now passes, remove it from EXPECTED_FAIL (VIL-467): ${unexpectedPass.join(', ')}`,
    );
  if (unknown.length > 0)
    lines.push(`FAIL EXPECTED_FAIL lists unknown case ids: ${unknown.join(', ')}`);
  const ok = unexpectedFail.length === 0 && unexpectedPass.length === 0 && unknown.length === 0;
  return { ok, unexpectedFail, unexpectedPass, unknown, expectedFailed, lines };
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
    references: REMINDER_REFERENCE_TEXTS,
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
    const composed =
      broken && !rescore
        ? null
        : (
              await cachedToolCall({
                tag: `reminder:${fixture.id}`,
                model,
                lane,
                system: skill.instructions,
                userMessage,
                toolName: 'reminder_texts',
                toolSchema: TOOL_SCHEMA,
                toolDescription: 'The texts Hale sends the parent, in order.',
                maxTokens: 1024,
                cachedOnly: cachedOnly || rescore,
                dryPlan: dry ? composePlan : undefined,
                getClient,
                cost,
              })
            ).value;
    const texts = composed === null ? [BROKEN] : readTexts(composed);
    const bold = composed === null ? null : readBold(composed);
    // Numbered, so the judge can see where the model split (P0 split / voice cases).
    const body = [...texts.map((t, i) => `[text ${i + 1}] ${t}`), boldLine(texts, bold)].join(
      '\n',
    );
    const failures = compose.reminderRefusals(texts, facts).map((r) => `unsendable:${r}`);
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
      const failures = compose
        .reminderRefusals(bc.body.split('\n'), facts)
        .map((r) => `unsendable:${r}`);
      const bcTexts = bc.body.split('\n');
      const bcBody = [
        ...bcTexts.map((t, i) => `[text ${i + 1}] ${t}`),
        boldLine(bcTexts, bc.bold ?? null),
      ].join('\n');
      const verdict = await judge(bc.tag, {
        input: userMessage,
        text: bcBody,
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
  if (!broken) {
    // Cached-only (CI) honours EXPECTED_FAIL; a live or --rescore run still needs every case to pass.
    const gate = expectedFailGate(results, cachedOnly ? EXPECTED_FAIL : []);
    for (const line of gate.lines) console.log(line);
    process.exit(gate.ok ? 0 : 1);
  }
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
