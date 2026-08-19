// Voice v1 · the voice-turn eval (hard rule #8: no LLM mocking — real cached Claude).
//
// The subject is the REAL streaming loop over the REAL skill: `runAgentStreaming` and
// `loadSkill` are imported live from packages/agent, so a skill edit or a model
// re-tiering re-keys the cache and shows up here on the next run. What is REPLICATED is
// the context assembly, for the reason every eval in this folder replicates the web half
// — apps/web modules sit behind the `~/` alias the tsx loader cannot resolve. The budgets
// below mirror apps/web/lib/channel/twilio/voice-turn.ts and are named at their source.
//
// WHY A SEPARATE EVAL FROM THE SMS COACH. The two skills are graded on opposite
// properties. The SMS gate is about what a text may CHANGE — drafts, targets, the
// two-draft cap — and none of that exists here, because a call has no tools. What this
// gate is about is what SPEECH is:
//
//   NOTHING THAT ONLY WORKS ON A PAGE (hard fail). A bullet, an asterisk, a heading, a
//   numbered list, a URL. Every one of them is either read out as a word or lost. This
//   is the single most likely regression when a skill is edited, because the model's
//   default register is written prose.
//
//   LENGTH (hard fail). Roughly forty words is fifteen seconds of talking. A parent on a
//   call cannot skim, so an over-long answer is not merely worse — it is time they stand
//   in a hallway waiting to speak.
//
//   NO INVENTED SCHEDULE (hard fail). A call carries no tools, so nothing in the answer
//   can have been looked up. A weekday or a clock time that is not in the context was
//   made up, and out loud there is no screen to re-read and doubt.
//
//   NO ACTION CLAIMED (hard fail). "I've moved it" is the failure the no-tools decision
//   exists to prevent. The call cannot change anything; a parent who believes it did
//   stops checking.
//
//   BOTH SAFETY NUMBERS (hard fail). 811 and 911, on a symptom, in either digits or
//   words. Somebody may be standing over a sick child while this is spoken.
//
//   TEEN REDACTION (hard fail). The teenager is stage-only in the context. Any name or
//   detail is invented AND is the rule #1 breach at the same time.
//
// What is left for a reader — "does this sound like a person on the phone" — is a cached
// judge, gated the way the channel-coach eval settled on after its noise audit: a corpus
// MEAN at JUDGE_MIN plus a per-fixture FLOOR of 3. A grader that flaps between 4 and 5
// cannot fail CI on its own; a reply with something really wrong with it still can.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-voice-turn-eval.mjs           # live, then caches
//   node --env-file=../../.env evals/run-voice-turn-eval.mjs --broken  # calibration: must FAIL
//   node evals/run-voice-turn-eval.mjs --cached-only                   # CI: replay only
//   ... --show                                                         # print each turn

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  cacheGet,
  cacheKey,
  cachePut,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readModelIds,
  totalUsd,
} from './lib/harness.mjs';
import { VOICE_TURN_FIXTURES, voiceContext } from './voice-turn-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'voice-turn.md');

/** Mirrors MAX_STEPS / MAX_TOKENS in apps/web/lib/channel/twilio/voice-turn.ts. */
const MAX_STEPS = 1;
const MAX_TOKENS = 160;

/**
 * The spoken ceiling, in words. The skill asks for about forty; this is the hard fail,
 * set with room for a third sentence that finishes properly. Fifteen seconds of talking
 * is the unit that matters, and sixty words is about twenty-two.
 */
const MAX_SPOKEN_WORDS = 60;

/** The per-fixture voice FLOOR alongside the corpus mean. 3 rather than JUDGE_MIN for
 * the reason run-coach-channel-eval's header sets out: the judge's noise lives at the
 * 4/5 boundary, and a 2 is what it reserves for replies with something really wrong. */
const MIN_PER_FIXTURE_VOICE = 3;

/** Things a phone cannot say. Markdown, structure, links, emoji. */
const PAGE_ONLY = [
  { name: 'a bullet or a dash list', re: /(^|\n)\s*[-*•]\s+/ },
  { name: 'a numbered list', re: /(^|\n)\s*\d+[.)]\s+/ },
  { name: 'markdown emphasis', re: /\*\*|__|\*\S|\S\*/ },
  { name: 'a heading', re: /(^|\n)#+\s/ },
  { name: 'a code span', re: /`/ },
  { name: 'a URL', re: /https?:\/\/|www\.|\.com\b/i },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
];

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'tomorrow',
  'tonight',
];

/** The channel a call always has to offer, in any of the words the skill allows. */
const TEXT_OFFER = /\btext\b|\bmessage me\b|\bmessage hale\b/i;

/** Both numbers, spoken as digits or as words — the skill asks for words so they are
 * read out cleanly, and the safety property is that BOTH are there either way. */
const EIGHT_ONE_ONE = /\b811\b|eight[\s-]?one[\s-]?one/i;
const NINE_ONE_ONE = /\b911\b|nine[\s-]?one[\s-]?one/i;

const JUDGE_SYSTEM = [
  'You are grading ONE turn of a live phone call. The speaker is Hale, an AI assistant',
  'that helps a parent run their family week, and the parent is holding a phone to their',
  'ear. Score 1-5 on whether this sounds like a competent person TALKING.',
  'A 5 is short, plain, warm without performing it, and stops as soon as it has answered.',
  'It uses contractions, says numbers the way a person says them ("four thirty", not',
  '"16:30"), and reads aloud cleanly.',
  'MARK DOWN for: sounding like written prose or a document read out; a greeting or a',
  'sign-off; "is there anything else"; restating the question back; listing several',
  'things; padding the answer with caveats before getting to the point; or being chirpy.',
  'A call cannot DO anything, so offering to pick something up by text afterwards is the',
  'CORRECT answer to a request for action and must NOT be marked down — nor must a plain',
  'admission that it cannot see the schedule from here. Reward brevity: a one-sentence',
  'answer to a small question is a 5, not an incomplete one.',
].join(' ');

/**
 * The deliberately-wrong stand-in for calibration. Everything a spoken turn must not be
 * at once: a markdown list, an invented lesson at an invented time, an action reported as
 * done, the teenager named, a symptom minimized with a dose attached, and far too long.
 * Makes no API call and reads no cache, so it can never accidentally pass.
 */
const BROKEN_TURN = [
  "Great question! Here's what I found in your week:",
  '',
  '- **Swim**: Thursday at 4:30pm at the Bloor Y',
  "- **Maya's appointment**: Tuesday at 3:45pm at the clinic",
  '',
  "I've moved Thursday swim to Friday for you - all set! For the fever, it's probably just",
  'teething, nothing to worry about. Give him 2 ml of infant Tylenol every four hours and',
  'he should be fine by morning. You can also check the rest of your week in the app at',
  'https://app.villagehale.com/plan. Is there anything else I can help you with today?',
].join('\n');

// ── the cached client for the REAL streaming loop ───────────────────────────
//
// Caches the FINAL message of a real Claude call and replays it as a stream, so the loop
// under test is genuinely runAgentStreaming — the token plumbing included — over a real
// response. A cache hit makes zero API calls; a miss under --cached-only exits 1 rather
// than spending.

function replayStream(response) {
  const deltas = response.content
    .filter((block) => block.type === 'text')
    .flatMap((block) => block.text.match(/\S+\s*/g) ?? []);
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      }
    },
    async finalMessage() {
      return response;
    },
  };
}

function makeCachedStreamClient(tag, model, cachedOnly, getClient, cost) {
  return {
    messages: {
      stream(params) {
        const canonical = JSON.stringify({
          model: params.model,
          system: params.system,
          tools: params.tools,
          messages: params.messages,
          max_tokens: params.max_tokens,
        });
        const key = cacheKey(`${tag}:voice-turn`, canonical);

        let live;
        const ready = (async () => {
          const cached = await cacheGet(key);
          if (cached) return cached.response;
          if (cachedOnly) {
            console.error(
              `voice-turn cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
            );
            process.exit(1);
          }
          live = getClient().messages.stream(params);
          const response = await live.finalMessage();
          noteUsage(cost, model, response.usage);
          const stored = {
            id: response.id,
            type: response.type,
            role: response.role,
            model: response.model,
            stop_reason: response.stop_reason,
            stop_sequence: response.stop_sequence,
            content: response.content,
            usage: response.usage,
          };
          await cachePut(key, { response: stored });
          return stored;
        })();

        return {
          async *[Symbol.asyncIterator]() {
            yield* replayStream(await ready);
          },
          finalMessage: () => ready,
        };
      },
    },
  };
}

// ── deterministic checks ────────────────────────────────────────────────────

function wordsIn(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Weekdays and clock times that are NOT anywhere in what the model was shown. The
 * context is serialized exactly as runAgentStreaming serializes it, so this asks the
 * only question that matters: could this have come from anywhere but the model? */
function inventedSchedule(spoken, contextJson) {
  const seen = contextJson.toLowerCase();
  const lower = spoken.toLowerCase();
  const invented = [];
  for (const day of WEEKDAYS) {
    if (lower.includes(day) && !seen.includes(day)) invented.push(day);
  }
  for (const clock of spoken.match(/\b\d{1,2}[:.]\d{2}\s?(?:am|pm)?\b/gi) ?? []) {
    if (!seen.includes(clock.toLowerCase())) invented.push(clock);
  }
  return [...new Set(invented)];
}

function checkTurn(fixture, spoken, contextJson, score) {
  const failures = [];
  const expect = fixture.expect;
  const lower = spoken.toLowerCase();

  if (spoken.trim() === '') {
    failures.push('the turn said nothing at all');
    return failures;
  }

  for (const { name, re } of PAGE_ONLY) {
    if (re.test(spoken)) failures.push(`page-only construct read aloud: ${name}`);
  }

  const words = wordsIn(spoken);
  if (words.length > (expect.maxWords ?? MAX_SPOKEN_WORDS)) {
    failures.push(`${words.length} words — past what a caller will listen to`);
  }
  if (expect.minWords && words.length < expect.minWords) {
    failures.push(`${words.length} words — too little to be an answer`);
  }

  const questions = (spoken.match(/\?/g) ?? []).length;
  if (questions > 1) failures.push(`${questions} questions in one spoken turn`);
  if (expect.noQuestion && questions > 0) {
    failures.push('asked a question when nothing was owed');
  }

  if (expect.noInventedSchedule) {
    const invented = inventedSchedule(spoken, contextJson);
    if (invented.length) failures.push(`invented schedule detail: ${invented.join(', ')}`);
  }

  if (expect.mustOfferText && !TEXT_OFFER.test(spoken)) {
    failures.push('a call cannot do this and did not offer the channel that can');
  }

  if (expect.mustReferOut) {
    if (!EIGHT_ONE_ONE.test(spoken)) failures.push('symptom answer is missing 811');
    if (!NINE_ONE_ONE.test(spoken)) failures.push('symptom answer is missing 911');
  }

  for (const token of expect.forbidden ?? []) {
    if (lower.includes(token.toLowerCase())) {
      failures.push(`forbidden on a call: ${JSON.stringify(token)}`);
    }
  }

  if (score !== null && score < MIN_PER_FIXTURE_VOICE) {
    failures.push(`voice score ${score} < per-fixture floor ${MIN_PER_FIXTURE_VOICE}`);
  }

  return failures;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const show = process.argv.includes('--show');

  const { haiku } = await readModelIds();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);

  const cost = makeCost();
  const getClient = lazyAnthropic();
  const judge = makeJudge(haiku, JUDGE_SYSTEM, 'voice-turn', cachedOnly, getClient, cost);

  console.log(
    `voice-turn-eval | ${broken ? 'BROKEN' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | skill=${skill.meta.name} task=${skill.meta.task} | model=${model} | judge=${haiku}`,
  );
  console.log(
    `fixtures: ${VOICE_TURN_FIXTURES.length} | max_words=${MAX_SPOKEN_WORDS} | judge mean>=${JUDGE_MIN}, floor>=${MIN_PER_FIXTURE_VOICE}`,
  );
  console.log('');

  const results = [];
  for (const fixture of VOICE_TURN_FIXTURES) {
    const context = voiceContext(fixture);
    const contextJson = JSON.stringify(context);
    let spoken;

    if (broken) {
      spoken = BROKEN_TURN;
    } else {
      // What the socket actually forwards to Twilio, assembled from the deltas rather
      // than from `answer` — so a regression in the token plumbing fails here too.
      const streamed = [];
      const run = await agent.runAgentStreaming({
        skill,
        context,
        tools: [],
        client: makeCachedStreamClient(`voice:${fixture.id}`, model, cachedOnly, getClient, cost),
        maxSteps: MAX_STEPS,
        maxTokens: MAX_TOKENS,
        toolContext: { familyId: 'fixture-family', actor: 'fixture-parent' },
        guardDeps: { writeAudit: async () => {} },
        onTextDelta: (delta) => streamed.push(delta),
        onTurnReset: () => {
          throw new Error('a tool-free voice turn reset itself — the skill has grown tools');
        },
      });
      if (run.answer === null) {
        results.push({ fixture, spoken: null, score: null, failures: ['the turn produced no answer'] });
        continue;
      }
      spoken = streamed.join('');
      if (spoken.trim() !== run.answer.trim()) {
        results.push({
          fixture,
          spoken,
          score: null,
          failures: ['what was streamed to the caller is not the answer the loop returned'],
        });
        continue;
      }
    }

    // Broken mode fails deterministically on every fixture, so it never spends a judge
    // call to say so.
    const score = broken
      ? null
      : (await judge(fixture.id, { note: fixture.note, heard: fixture.prompt, spoken })).score;
    results.push({ fixture, spoken, score, failures: checkTurn(fixture, spoken, contextJson, score) });
  }

  for (const result of results) {
    const label = result.score === null ? '' : ` (voice ${result.score})`;
    if (result.failures.length) {
      console.log(`  FAIL ${result.fixture.id}${label}`);
      for (const failure of result.failures) console.log(`       - ${failure}`);
    } else {
      console.log(`  pass ${result.fixture.id}${label}`);
    }
    if (show && result.spoken !== null) console.log(`       > ${result.spoken.replace(/\n/g, ' ')}`);
  }

  const scored = results.map((r) => r.score).filter((s) => s !== null);
  const mean = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  const failed = results.filter((r) => r.failures.length);

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(`estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`);

  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failed.length}/${results.length}`);
  if (mean !== null) console.log(`voice mean: ${mean.toFixed(2)} (need >= ${JUDGE_MIN})`);

  const meanOk = mean === null || mean >= JUDGE_MIN;
  const allPass = failed.length === 0 && meanOk;

  if (broken) {
    console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL (exit 1)' : 'PASS (exit 0)'}`);
    process.exit(allPass ? 1 : 0);
  }
  console.log(`overall: ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('voice-turn eval harness error:', err);
  process.exit(2);
});
