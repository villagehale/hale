// Full coaching plans · the plan + note composers (hard rule #8: no LLM mocking).
//
// The subject is TWO real skills — packages/agent/skills/coach-plan.md and
// coach-plan-note.md — run through the REAL forced-tool-JSON request shapes
// apps/web/lib/channel/plan/{compose,note}.ts build. Those modules sit behind the web
// `~/` alias, so their request shapes and gates are REPLICATED here; the SKILL bodies,
// the model routing and the CURATED PLAYBOOKS are imported live, so a skill edit, a
// re-tiering, or a change to the verified method content re-keys the cache and shows up
// as a miss rather than as silence.
//
// WHAT CHANGED IN THE SECOND PASS, and why this eval looks different from its siblings:
// the plan is no longer graded as prose. It is graded against the PLAYBOOK. The judge is
// handed the curated method as ground truth and told to treat any claim outside it as a
// fabrication, and the deterministic gates check the parts a judge reads past — the
// method named, the playbook's own intervals unchanged, no person cited who was not
// vetted, and the promised day matching the structured field the ledger will fire on.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-coach-plan-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-coach-plan-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-coach-plan-eval.mjs --cached-only                    # CI: replay only
//   ... --show                                                          # print each output
//
// THE HARD ZEROS:
//   · unsendable — anything the runtime gates would refuse. The composer is
//     all-or-nothing and has no fallback body, so a refused plan is a parent who said
//     yes and got silence until a retry.
//   · ungrounded — an interval or a claim the playbook does not contain, or a named
//     person who is not on its vetted list. This is the failure the whole second pass
//     exists to end.
//   · unnamed method — a plan that will not say "the Ferber method".
//   · a plan for a child the age gate refuses.
//   · a promised day that does not match the structured checkInDays.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playbookFor } from '@hale/types';
import { tsImport } from 'tsx/esm/api';
import { COACH_PLAN_FIXTURES } from './coach-plan-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readModelIds,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const PLAN_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'coach-plan.md');
const NOTE_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'coach-plan-note.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

/** The day each allowed offset lands on, fixed so the corpus is deterministic. Monday
 * is "today", so 2=Wednesday ... 5=Saturday. */
const CHECK_IN_DAY_NAMES = { 2: 'Wednesday', 3: 'Thursday', 4: 'Friday', 5: 'Saturday' };

// ── replicated: apps/web/lib/channel/plan/compose.ts ────────────────────────

/** Mirrors `planJsonSchema`. Three named string fields, not an array: the first live
 * recording returned `messages` as a JSON-encoded STRING and production's z.array would
 * have thrown a good plan away. */
const PLAN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    first: { type: 'string', description: 'The first plan message.' },
    second: { type: 'string', description: 'The second plan message.' },
    third: { type: 'string', description: 'The third plan message. Omit for a two-message plan.' },
    checkInDays: {
      type: 'integer',
      enum: [2, 3, 4, 5],
      description:
        'How many days from today Hale should check back in. Your final message must promise this day by name.',
    },
  },
  required: ['first', 'second', 'checkInDays'],
};

/** Mirrors `noteJsonSchema`. */
const NOTE_TOOL_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

/** Mirrors MAX_COMPOSE_ATTEMPTS / MAX_NOTE_ATTEMPTS. The runtime feeds a refusal back
 * and rewrites, so an eval that graded only the FIRST draft would be grading something
 * no parent ever receives. This corpus runs the same loop and reports the attempt count,
 * which is also the honest read on how often the skill's first draft is over budget. */
const MAX_ATTEMPTS = 3;

/** Mirrors `retryUserMessage` / `retryNoteMessage`: the violations ride in the SAME
 * payload, so each attempt is a distinct content-addressed cache key. */
function withViolations(base, violations) {
  if (violations.length === 0) return base;
  return JSON.stringify({ ...JSON.parse(base), rejectedLastAttempt: violations });
}

const PLAN_MAX_TOKENS = 2048;
const NOTE_MAX_TOKENS = 400;
/** Mirrors MAX_PLAN_SEGMENTS / MIN_PLAN_MESSAGES / MAX_PLAN_MESSAGES in compose.ts. */
const MAX_PLAN_SEGMENTS = 3;
const MIN_PLAN_MESSAGES = 2;
const MAX_PLAN_MESSAGES = 3;
/** Mirrors MAX_NOTE_SEGMENTS in note.ts. */
const MAX_NOTE_SEGMENTS = 2;
/** Mirrors DOSING_SHAPE / LINK_SHAPE / NAMED_PERSON in compose.ts. */
const DOSING_SHAPE = /\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|milligrams?|millilitres?|milliliters?)\b/i;
const LINK_SHAPE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ca|org|net|io|co|tv)\b/i;
const NAMED_PERSON = /\b(?:Dr\.?|Doctor|Professor|Prof\.?)\s+[A-Z][a-z]+/g;
/** Mirrors `reachesForTheHealthLine` in off-domain/copy.ts. */
const HEALTH_LINE_SHAPE = /\b(?:811|911)\b/;
const MARKDOWN_SHAPE = /[*_#`]|^\s*[-•]/m;

/** Mirrors `withoutChannelUrl` in compose.ts. */
function withoutChannelUrl(credential) {
  return credential.replace(/;\s*(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\/\S*\s*$/i, '');
}

/** Mirrors `planUserMessage` — the exact payload the model is handed. */
function planUserMessage(fixture, playbook) {
  return JSON.stringify({
    question: fixture.question,
    child: fixture.child,
    facts: [],
    checkInDayNames: CHECK_IN_DAY_NAMES,
    playbook: {
      topic: playbook.topic,
      primaryMethod: playbook.primaryMethod,
      alternativeMethod: playbook.alternativeMethod,
      readinessSigns: playbook.readinessSigns,
      neverDo: playbook.neverDo,
      doctorTriggers: playbook.doctorTriggers,
      goDeeper: playbook.goDeeper.map((creator) => ({
        name: creator.name,
        credential: withoutChannelUrl(creator.credential),
        goodFor: creator.goodFor,
      })),
    },
  });
}

/** Mirrors `noteUserMessage`. */
function noteUserMessage(fixture, playbook) {
  const shared = { kind: fixture.kind, topic: fixture.topic, child: fixture.child ?? null };
  if (fixture.kind === 'too_young') {
    return JSON.stringify({
      ...shared,
      question: fixture.question,
      method: playbook.primaryMethod.name,
      ageGate: playbook.primaryMethod.ageGate,
      doctorTriggers: playbook.doctorTriggers,
      readinessSigns: playbook.readinessSigns,
    });
  }
  return JSON.stringify({ ...shared, promise: fixture.promise });
}

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

// ── this eval's own gates ───────────────────────────────────────────────────

/**
 * A STAGE LABEL — a concrete time reference that makes a message a stage rather than a
 * paragraph.
 *
 * Both orders count, and the live corpus is why: the chair method runs on "Every 3
 * nights, move the chair farther" rather than on numbered nights, so a pattern that only
 * knew "Nights 1-3" called a correctly-sequenced plan unsequenced.
 */
const STAGE_LABEL =
  /\b(?:nights?|days?|weeks?)\s*\d|\d+\s*(?:-\s*\d+\s*)?(?:nights?|days?|weeks?)\b|\bby\s+(?:night|day|week)\s*\d|\bafter\s+(?:that|the\s+first)\b|\bfrom\s+(?:night|day|week)\s*\d/i;
const MIN_LABELLED_STAGES = 2;

const SPELLED_NUMBER =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half|twice|once|couple)\b/i;

/** A concrete specific — a quantity that is not part of the stage's own label. The label
 * is stripped first, so a plan made entirely of headings cannot pass. */
function hasSpecific(body) {
  const withoutLabels = body.replace(/\b(?:nights?|days?|weeks?)\s*\d+(?:\s*-\s*\d+)?/gi, ' ');
  return /\d/.test(withoutLabels) || SPELLED_NUMBER.test(withoutLabels);
}

/** Mirrors `namesTheMethod` in compose.ts. EITHER method counts: the playbooks say when
 * the alternative is the right call, so a plan that switches is the playbook working. */
function namesTheMethod(text, playbook) {
  const haystack = text.toLowerCase();
  return [
    ...methodTokens(playbook.primaryMethod.name),
    ...methodTokens(playbook.alternativeMethod.name),
  ].some((token) => haystack.includes(token));
}

function methodTokens(rawName) {
  const name = rawName.toLowerCase();
  const tokens = [name];
  const inner = name.match(/\(([^)]+)\)/)?.[1];
  if (inner) tokens.push(inner);
  const leading = name.split('(')[0]?.trim();
  if (leading) tokens.push(leading);
  const head = leading?.split(/\s+/)[0];
  if (head && head.length >= 4) tokens.push(head);
  return tokens;
}

/** Mirrors `playbookSanctionsTheHealthLine` in compose.ts — solids' own verified
 * triggers open "Call 911 now", because anaphylaxis is the emergency the blanket rule
 * was written to stop Hale INVENTING. */
function sanctionsTheHealthLine(playbook) {
  return playbook.doctorTriggers.some((trigger) => HEALTH_LINE_SHAPE.test(trigger));
}

function firstNameToken(name) {
  const bare = name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  return bare.startsWith('the ') ? bare.slice(4) : bare;
}

/** Every sendability failure the runtime would raise, in its own vocabulary. */
function sendFailures(messages, smsSegments, maxSegments, { allowMany, playbook }) {
  const failures = [];
  if (allowMany && (messages.length < MIN_PLAN_MESSAGES || messages.length > MAX_PLAN_MESSAGES)) {
    failures.push(`wrong_shape:${messages.length} messages`);
  }
  const sirenAllowed = sanctionsTheHealthLine(playbook);
  for (const [index, body] of messages.entries()) {
    if (body === '') failures.push(`empty:${index}`);
    if (smsSegments(body) > maxSegments) {
      failures.push(`over_budget:${index} (${smsSegments(body)} segments)`);
    }
    if (LINK_SHAPE.test(body)) failures.push(`carries_link:${index}`);
    if (DOSING_SHAPE.test(body)) failures.push(`carries_dosing:${index}`);
    if (HEALTH_LINE_SHAPE.test(body) && !sirenAllowed) {
      failures.push(`reaches_for_the_health_line:${index}`);
    }
  }
  return failures;
}

/**
 * THE FABRICATION GATE — a person named who was never vetted.
 *
 * The counterpart of the coach-channel eval's invented-event gate, and the same
 * argument: a citation a parent will act on has to trace to something. Any "Dr X" in
 * the output is checked against the topic's goDeeper list, and more than one vetted
 * name is also a failure (the rule is at most one, after the plan).
 */
function citationFailures(text, playbook) {
  const failures = [];
  const allowed = playbook.goDeeper.map((creator) => creator.name.toLowerCase());
  for (const cited of text.matchAll(NAMED_PERSON)) {
    const bare = cited[0].replace(/^(Dr\.?|Doctor|Professor|Prof\.?)\s+/i, '').toLowerCase();
    if (!allowed.some((ok) => ok.includes(bare))) failures.push(`FABRICATED CITATION: ${cited[0]}`);
  }
  const mentioned = playbook.goDeeper.filter((creator) =>
    text.toLowerCase().includes(firstNameToken(creator.name)),
  );
  if (mentioned.length > 1) failures.push(`cites ${mentioned.length} people (at most one)`);
  return failures;
}

/**
 * The violations the RUNTIME would recompose on, phrased as it phrases them.
 *
 * Deliberately not the same set as the eval's own failures: production rewrites on a
 * sendability or grounding fault, and knows nothing about a fixture's `mustMention` or
 * the judge. Mixing them would have the eval retrying until the corpus was satisfied,
 * which is grading a loop this code does not have.
 */
function runtimeViolations(flat, playbook, checkInDays, smsSegments, isPlan) {
  const violations = [];
  const maxSegments = isPlan ? MAX_PLAN_SEGMENTS : MAX_NOTE_SEGMENTS;
  const sirenAllowed = sanctionsTheHealthLine(playbook);

  if (isPlan && (flat.length < MIN_PLAN_MESSAGES || flat.length > MAX_PLAN_MESSAGES)) {
    violations.push(`The plan came back as ${flat.length} usable message(s); it must be exactly 2 or 3.`);
  }
  flat.forEach((body, index) => {
    const label = isPlan ? `Message ${index + 1}` : 'The message';
    const limit = maxSegments * 153;
    if (smsSegments(body) > maxSegments) {
      violations.push(
        isPlan
          ? `${label} is ${body.length} characters, ${body.length - limit} over the ${limit} limit, and the WHOLE plan is refused for it. Move a sentence into another message rather than deleting the content.`
          : `${label} is ${body.length} characters, ${body.length - limit} over the ${limit} limit. Shorten it.`,
      );
    }
    if (LINK_SHAPE.test(body)) violations.push(`${label} contains a link or a web address.`);
    if (DOSING_SHAPE.test(body)) violations.push(`${label} names a dose.`);
    if (HEALTH_LINE_SHAPE.test(body) && !sirenAllowed) {
      violations.push(`${label} gives a phone number. Name the SITUATION instead, with no number.`);
    }
  });

  const whole = flat.join(' ');
  if (isPlan) {
    if (!namesTheMethod(whole, playbook)) {
      violations.push(`The plan never names the method. Say "${playbook.primaryMethod.name}".`);
    }
    const promised = CHECK_IN_DAY_NAMES[checkInDays];
    if (promised && !whole.toLowerCase().includes(promised.toLowerCase())) {
      violations.push(`Your last message must promise the day: "${promised}".`);
    }
  }
  for (const bad of citationFailures(whole, playbook)) violations.push(bad);
  return violations;
}

// ── the judges ──────────────────────────────────────────────────────────────

const PLAN_JUDGE_SYSTEM = [
  'You are a strict reviewer scoring a COMPLETE coaching plan Hale has just texted a',
  'parent as two or three messages. The parent asked a raising-kids question, got a',
  'two-sentence answer, was offered the whole plan, and said yes. This is what arrived.',
  'You are given the question, the child age in months, THE PLAYBOOK Hale was required',
  'to build the plan from, the plan messages in order, and watchFor - fixture-specific',
  'notes on what right and wrong look like here. Score 1-5.',
  'THE PLAYBOOK IS GROUND TRUTH. Hale is required to take its method, its intervals and',
  'its claims FROM the playbook and not from anywhere else. Any instruction, interval,',
  'age or claim in the plan that is not supported by the playbook is a FABRICATION and',
  'caps the score at 2, however plausible it sounds - the point of the playbook is that',
  'it was source-verified and an improvisation was not. Contradicting the playbook',
  'scores 1.',
  'A 5 is a plan a parent could start TONIGHT: the method NAMED, one line of why it is',
  'worth doing, then the sequence in labelled stages with the playbook\'s own specifics,',
  'what to EXPECT including the point where it looks like it is failing, how to tell it',
  'is working, and the day Hale will check back. It recommends ONE method plainly and',
  'names the alternative in a clause rather than presenting both evenly.',
  'A LOW score is any of: advice so general it would fit any age or family ("be',
  'consistent") - the most common failure, 2 or below; a plan that answers a different',
  'question than the one asked; guaranteeing an outcome; clinical or lecturing register;',
  'naming a medicine, a dose or a diagnosis; a phone number; scolding the parent.',
  'Do NOT reward length. Three long messages of generalities score worse than two short',
  'grounded ones. Reply with ONLY the score tool.',
].join(' ');

const NOTE_JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short text Hale sends a parent on the coaching',
  'path. `kind` says which moment it is. Score 1-5, and reply with ONLY the score tool.',
  'kind "too_young": the parent asked for a plan and their child is below the method\'s',
  'verified age gate, so this is a NO. A 5 says it straight in the first clause, gives',
  'the reason from the ageGate in a clause, says when it opens, and gives ONE thing to',
  'do or watch for meanwhile. A LOW score is any of: giving the plan anyway (score 1),',
  'a wait with nothing in it, an apology tour, hedging so much the answer is unclear, a',
  'phone number, or a claim not supported by the ageGate provided.',
  'kind "check_in": days ago Hale sent a full plan and promised to check in today. A 5',
  'is ONE warm question, ending on it, that makes the honest answer easy to give -',
  'including that it went badly. A LOW score is any of: re-teaching or naming the method',
  'back at them (this is the most common failure - they already have the plan); two',
  'questions; a tip bolted on; assuming it went well; apologising for interrupting;',
  'anything that reads as a scorecard or as an automated template.',
  'Both kinds: no markdown, no emoji, no links, no greeting or sign-off, first person.',
].join(' ');

/** Deterministic stand-ins, in the RIGHT SHAPE so the calibration exercises the content
 * gates rather than failing on the cheapest structural one. */
const BROKEN_PLAN = {
  first:
    '**Sleep plan:** Every child is different, so be consistent and establish a routine. It depends on your child.',
  second:
    'Dr. Marsden recommends waiting 45 minutes between checks. If it is not working, give 5ml and call 811. More at example.com.',
  checkInDays: 3,
};
const BROKEN_NOTE = {
  message:
    '**Update:** It depends on your child - every child is different. Want to try anyway? Call 811 if worried. More at example.com.',
};

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const show = process.argv.includes('--show');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsSegments } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);

  const planSkill = await agent.loadSkill(PLAN_SKILL);
  const noteSkill = await agent.loadSkill(NOTE_SKILL);
  const planModel = agent.pickModel(planSkill.meta.task);
  const noteModel = agent.pickModel(noteSkill.meta.task);
  // A Sonnet judge, not the harness default: these are three-paragraph plans whose
  // failure mode is a shade of generality, and Haiku flapped on exactly that class in
  // the coach-channel corpus. The run is cached, so the tier costs once.
  const judgeModel = (await readModelIds()).sonnet;
  const planJudge = makeJudge(judgeModel, PLAN_JUDGE_SYSTEM, 'coach-plan', cachedOnly, getClient, cost);
  const noteJudge = makeJudge(judgeModel, NOTE_JUDGE_SYSTEM, 'coach-note', cachedOnly, getClient, cost);

  console.log(
    `coach-plan eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | plan=${planModel} note=${noteModel} judge=${judgeModel}`,
  );
  console.log(`corpus: ${COACH_PLAN_FIXTURES.length} fixtures\n`);

  const results = [];
  const markdownSeen = new Set();
  for (const fixture of COACH_PLAN_FIXTURES) {
    const playbook = playbookFor(fixture.topic);
    const isPlan = fixture.kind === 'plan';

    // THE RECOMPOSE LOOP, run exactly as the runtime runs it, so what is graded is what
    // a parent would actually receive rather than the model's first draft.
    const base = isPlan ? planUserMessage(fixture, playbook) : noteUserMessage(fixture, playbook);
    let violations = [];
    let flat = [];
    let checkInDays = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= (broken ? 1 : MAX_ATTEMPTS); attempt += 1) {
      attempts = attempt;
      const value = broken
        ? isPlan
          ? BROKEN_PLAN
          : BROKEN_NOTE
        : (
            await cachedToolCall({
              tag: `${isPlan ? 'coach-plan' : 'coach-note'}:${fixture.id}`,
              model: isPlan ? planModel : noteModel,
              system: isPlan ? planSkill.instructions : noteSkill.instructions,
              userMessage: withViolations(base, violations),
              toolName: isPlan ? 'plan' : 'note',
              toolSchema: isPlan ? PLAN_TOOL_SCHEMA : NOTE_TOOL_SCHEMA,
              toolDescription: isPlan
                ? 'Return the plan as two or three text messages in order, plus how many days from today to check back.'
                : 'Return the one message to send.',
              maxTokens: isPlan ? PLAN_MAX_TOKENS : NOTE_MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value;

      checkInDays = isPlan ? value.checkInDays : null;
      const messages = isPlan
        ? [value.first, value.second, ...(value.third === undefined ? [] : [value.third])]
        : [value.message];
      flat = messages.map(flatten).filter((body) => body !== '');
      if (messages.some((body) => MARKDOWN_SHAPE.test(body))) markdownSeen.add(fixture.id);

      violations = runtimeViolations(flat, playbook, checkInDays, smsSegments, isPlan);
      if (violations.length === 0) break;
    }
    const whole = flat.join(' ');
    const failures = sendFailures(flat, smsSegments, isPlan ? MAX_PLAN_SEGMENTS : MAX_NOTE_SEGMENTS, {
      allowMany: isPlan,
      playbook,
    });
    if (markdownSeen.has(fixture.id)) failures.push('markdown');
    failures.push(...citationFailures(whole, playbook));

    if (isPlan) {
      // Counted across the PLAN, not per message. The first message is the what/why by
      // design — the skill puts the method and one line of evidence there — so requiring
      // a label in two separate messages was forcing a timeframe into the rationale.
      // Two labels anywhere is what "sequenced" actually means.
      const labels = (whole.match(new RegExp(STAGE_LABEL.source, 'gi')) ?? []).length;
      if (labels < MIN_LABELLED_STAGES) {
        failures.push(`not_sequenced (${labels} stage labels in the whole plan)`);
      }
      const vague = flat.slice(0, -1).map((body, i) => (hasSpecific(body) ? null : i)).filter((i) => i !== null);
      if (vague.length > 0) failures.push(`not_concrete (stages ${vague.join(', ')})`);
      if (!namesTheMethod(whole, playbook)) {
        failures.push(`UNNAMED METHOD (never says "${playbook.primaryMethod.name}")`);
      }
      const promised = CHECK_IN_DAY_NAMES[checkInDays];
      if (!promised) {
        failures.push(`checkInDays out of band: ${checkInDays}`);
      } else if (!whole.toLowerCase().includes(promised.toLowerCase())) {
        // The ledger row fires on the structured field. A plan that promised a
        // different day than the one it chose is a broken promise by construction.
        failures.push(`PROMISED DAY MISMATCH (chose ${checkInDays} = ${promised}, never said it)`);
      }
      // Grounding: an interval the playbook does not contain is the fabrication this
      // whole pass exists to end, so the fixture names the ones that must survive.
      for (const token of fixture.expect.mustGround ?? []) {
        if (!whole.toLowerCase().includes(token.toLowerCase())) {
          failures.push(`UNGROUNDED: dropped "${token}", which the playbook specifies`);
        }
      }
      // A pattern, where the playbook's specific is a SEQUENCE rather than a phrase.
      // "Night 1: wait 3, then 5, then 10" is the playbook's own ladder written the way
      // a person writes it, and a literal "3 minutes" gate called that a fabrication.
      for (const [label, pattern] of Object.entries(fixture.expect.mustGroundPattern ?? {})) {
        if (!pattern.test(whole)) failures.push(`UNGROUNDED: ${label}`);
      }
    } else if (fixture.kind === 'check_in') {
      const questions = (whole.match(/\?/g) ?? []).length;
      if (questions !== 1) failures.push(`${questions} questions (exactly one)`);
    }

    for (const token of fixture.expect.mustMention ?? []) {
      if (!whole.toLowerCase().includes(token.toLowerCase())) failures.push(`never says "${token}"`);
    }
    for (const token of fixture.expect.forbidden ?? []) {
      if (whole.toLowerCase().includes(token.toLowerCase())) failures.push(`says "${token}"`);
    }

    const verdict = broken
      ? null
      : isPlan
        ? await planJudge(fixture.id, {
            question: fixture.question,
            ageMonths: fixture.child?.ageMonths ?? null,
            playbook: {
              primaryMethod: playbook.primaryMethod,
              alternativeMethod: playbook.alternativeMethod,
              readinessSigns: playbook.readinessSigns,
              neverDo: playbook.neverDo,
              doctorTriggers: playbook.doctorTriggers,
            },
            plan: flat,
            watchFor: fixture.expect.watchFor,
          })
        : await noteJudge(fixture.id, {
            kind: fixture.kind,
            ageMonths: fixture.child?.ageMonths ?? null,
            ageGate: fixture.kind === 'too_young' ? playbook.primaryMethod.ageGate : null,
            promise: fixture.promise ?? null,
            message: whole,
            watchFor: fixture.expect.watchFor,
          });
    if (verdict && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, flat, failures, score: verdict?.score ?? null, checkInDays, attempts });
  }

  console.log('--- outputs ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    const segs = r.flat.map((body) => smsSegments(body)).join('/');
    const day = r.checkInDays === null ? '' : ` +${r.checkInDays}d`;
    console.log(
      `${tag}  ${r.fixture.id.padEnd(22)} ${r.fixture.kind.padEnd(10)} msgs=${r.flat.length} seg=${segs}${day} tries=${r.attempts} score=${r.score ?? '-'}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
    if (show) for (const body of r.flat) console.log(`      > ${body}`);
  }

  const unsendable = results.filter((r) =>
    r.failures.some((f) => /^(wrong_shape|empty|over_budget|carries_|reaches_)/.test(f)),
  );
  const ungrounded = results.filter((r) =>
    r.failures.some((f) => f.startsWith('UNGROUNDED') || f.startsWith('FABRICATED CITATION')),
  );
  const unnamed = results.filter((r) => r.failures.some((f) => f.startsWith('UNNAMED METHOD')));
  const brokenPromise = results.filter((r) => r.failures.some((f) => f.startsWith('PROMISED DAY')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const scores = results.map((r) => r.score).filter((s) => typeof s === 'number');
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  console.log('\n--- corpus metrics ---');
  console.log(`UNSENDABLE:              ${unsendable.length}  (0 required - no fallback body exists)`);
  console.log(`UNGROUNDED / fabricated: ${ungrounded.length}  (0 required - the hard gate)`);
  console.log(`method never named:      ${unnamed.length}  (0 required)`);
  console.log(`promised-day mismatch:   ${brokenPromise.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(`mean score:              ${mean.toFixed(2)}  (of 5)`);
  console.log(
    `first draft accepted:    ${results.filter((r) => r.attempts === 1).length}/${results.length}  (not gated - the loop is production's, and a rewrite is a working gate, not a failure)`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  console.log(
    `broken-mode calibration (must fail at least one gate): ${allPass ? 'FAIL (exit 1)' : 'PASS (exit 0)'}`,
  );
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('coach-plan eval harness error:', err);
  process.exit(2);
});
