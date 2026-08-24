// The DEEP SYNTHESIS + REFUTATION eval — the two legs between three research turns and a
// parent's phone (hard rule #8: no LLM mocking).
//
// WHAT IT SCORES, and why these two together. The synthesis is the only stage that sees
// more than one page, so it is the only stage that can attach the town's fee to the
// venue's class — the mistake a three-angle fan-out makes newly easy and a single leg
// could barely produce. The refutation is what is supposed to catch it. Scoring the merge
// without its checker would grade a component nobody ships; scoring the checker without a
// real merge would grade a regex. So one run drives both: the model merges, the REAL
// refutation logic (replicated from activity/refute.ts) tries to break every fact, and
// the gates below read what survived.
//
// WHAT IT GATES, and each one is a way a parent gets hurt:
//
//   · unquotable fact — a `when`/`price`/`registration` whose span is not on the page the
//     model named. Zero are tolerated: production DROPS them, so a merge quietly producing
//     them looks exactly like a merge finding nothing.
//   · wrong-programme figure — the party-room rental sitting three lines under the toddler
//     fee. A parent turns up with the wrong money (`mustNotCarry`).
//   · invented from a leg that never ran — a registration date, or the sentence "not
//     posted yet", from an angle whose every fetch was refused. This is the 2026-08-21
//     defect one layer up from where it happened (`mustNotFill`).
//   · read past a cut — a fee "recalled" from beyond `pages_truncated`.
//   · dropped fact — a figure plainly on the page and on no slot (`mustCarry`). The
//     opposite failure, and the reason the corpus is calibrated in both directions.
//   · stretched to fit — a school-age class returned for a toddler question, where an
//     empty list is the right answer (`maxSlots`).
//
// NO LLM JUDGE, deliberately. This stage emits STRUCTURED DATA, not prose: there is no
// tone to grade, and every property that matters is checkable against a fixed page. It is
// the same call the drafter eval makes for `add_to_digest_only`.
//
// SHAPE. It replicates the runtime's request (activity/synthesis.ts) rather than importing
// it — that module sits behind the web app's `~/` alias, which the tsx loader here cannot
// resolve. The SKILL body and the model routing are imported LIVE from packages/agent, so
// an edit to either re-keys the cache and shows up as a miss.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-activity-synthesis-eval.mjs           # live, then caches
//   node --env-file=../../.env evals/run-activity-synthesis-eval.mjs --broken  # calibration: must FAIL
//   node evals/run-activity-synthesis-eval.mjs --cached-only                   # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { SYNTHESIS_FIXTURES } from './activity-synthesis-fixtures.mjs';
import {
  cacheGet,
  cacheKey,
  cachePut,
  lazyAnthropic,
  makeCost,
  noteUsage,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SYNTHESIS_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-synthesis.md');

/** Mirrors `SYNTHESIS_MAX_TOKENS` (activity/synthesis.ts). */
const SYNTHESIS_MAX_TOKENS = 32768;
/** Mirrors `MIN_QUOTE_CHARS` (activity/refute.ts). */
const MIN_QUOTE_CHARS = 8;

// ── the runtime's request shape, replicated ──────────────────────────────────

const SYNTHESIS_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          when_quote: { type: 'string' },
          when_source: { type: 'string' },
          price: { type: 'string' },
          price_quote: { type: 'string' },
          price_source: { type: 'string' },
          registration: { type: 'string' },
          registration_quote: { type: 'string' },
          registration_source: { type: 'string' },
          source_name: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['name', 'age_fit', 'source_name', 'source_url'],
      },
    },
  },
  required: ['slots'],
};

/** Mirrors `synthesisUserMessage` (activity/synthesis.ts). */
function synthesisUserMessage(fixture) {
  return JSON.stringify({
    mode: 'deep_synthesis',
    subject: fixture.subject,
    ...(fixture.town ? { town: fixture.town } : {}),
    ...(fixture.stage ? { stage: fixture.stage } : {}),
    ...(fixture.window ? { window: fixture.window } : {}),
    legs: fixture.legs,
  });
}

// ── the refutation, replicated from activity/refute.ts ───────────────────────

/** Mirrors `plainText`'s unicode folding (coach/reply.ts) — the same substitutions the
 * runtime's `normalise` runs through before comparing. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
];

function normalise(text) {
  let out = String(text);
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Mirrors `pageKey`: a scheme, a `www.`, a trailing slash and a fragment are not
 * identity; a PATH is. */
function pageKey(url) {
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/#.*$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function citation(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\/\S+$/i.test(raw) ? raw : null;
}

/** Every page the fan-out actually opened, indexed the way the runtime indexes it. The
 * fixtures carry page text inside `notes` behind a `--- page: <url> ---` marker, which is
 * exactly how the runtime builds them (fanout.ts `boundEvidence`). */
function pagesFrom(legs) {
  const byPage = new Map();
  for (const leg of legs) {
    if (!leg.notes) continue;
    for (const chunk of leg.notes.split('--- page: ')) {
      const [header, ...rest] = chunk.split('\n');
      const url = (header ?? '').replace(/\s*---\s*$/, '').trim();
      if (!url.startsWith('http')) continue;
      byPage.set(pageKey(url), normalise(rest.join('\n')));
    }
  }
  return byPage;
}

/** Mirrors `tryFact`. Returns the refusal reason, or null when the fact stands (or was
 * never asserted). */
function tryFact(value, quote, source, rowUrl, byPage) {
  const stated = typeof value === 'string' ? value.trim() : '';
  if (stated === '') return { kept: null, refusal: null };

  const span = typeof quote === 'string' ? quote.trim() : '';
  if (span === '') return { kept: null, refusal: 'no_quote' };

  const needle = normalise(span);
  if (needle.length < MIN_QUOTE_CHARS) return { kept: null, refusal: 'quote_too_short' };

  const cited = citation(source) ?? rowUrl;
  const pageText = byPage.get(pageKey(cited));
  if (pageText === undefined) return { kept: null, refusal: 'source_not_read' };
  if (!pageText.includes(needle)) return { kept: null, refusal: 'quote_absent' };
  return { kept: stated, refusal: null };
}

/** Mirrors `refuteSlots`. */
function refuteSlots(rows, byPage) {
  const slots = [];
  const slotRefusals = [];
  const factRefusals = [];

  for (const row of rows ?? []) {
    const sourceUrl = citation(row.source_url);
    if (sourceUrl === null) {
      slotRefusals.push('bad_citation');
      continue;
    }
    if (!byPage.has(pageKey(sourceUrl))) {
      slotRefusals.push('uncited_page');
      continue;
    }
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const ageFit = typeof row.age_fit === 'string' ? row.age_fit.trim() : '';
    const sourceName = typeof row.source_name === 'string' ? row.source_name.trim() : '';
    if (name === '' || ageFit === '' || sourceName === '') {
      slotRefusals.push('incomplete_row');
      continue;
    }

    const when = tryFact(row.when, row.when_quote, row.when_source, sourceUrl, byPage);
    const price = tryFact(row.price, row.price_quote, row.price_source, sourceUrl, byPage);
    const registration = tryFact(
      row.registration,
      row.registration_quote,
      row.registration_source,
      sourceUrl,
      byPage,
    );
    for (const verdict of [when, price, registration]) {
      if (verdict.refusal) factRefusals.push(verdict.refusal);
    }
    if (when.kept === null && price.kept === null && registration.kept === null) {
      slotRefusals.push('no_backed_fact');
      continue;
    }
    slots.push({
      name,
      ageFit,
      when: when.kept,
      price: price.kept,
      registration: registration.kept,
      sourceName,
      sourceUrl,
    });
  }
  return { slots, slotRefusals, factRefusals };
}

// ── the broken stand-in ──────────────────────────────────────────────────────

/**
 * One failure per gate, so `--broken` proves each one bites. Fully offline.
 *
 * PER FIXTURE, because the calibrations pull in opposite directions and one payload
 * cannot do all of them: a paraphrased quote proves the verbatim rule, an invented
 * registration date proves the failed-leg rule, a recalled fee proves the truncation
 * rule, and a stretched slot proves the empty-is-correct rule. Deriving the mode from
 * the expectations (which is what this started as) would leave three gates at zero —
 * gates nobody has ever seen fire.
 */
function brokenSynthesis(fixture) {
  switch (fixture.brokenMode) {
    // The quote is TIDIED — spacing normalised, the abbreviation expanded. Reads right,
    // is not on the page, and production drops the fact.
    case 'paraphrase':
      return {
        slots: [
          {
            name: 'Tiny Gym, Cartwheels Gym Centre',
            age_fit: 'walking to 3.5 years, with a parent',
            when: 'Sundays 9:30-10:15, September 14 to October 26',
            when_quote: 'Tiny Gym: Sundays, 9:30 to 10:15 AM, September 14 through October 26',
            price: '$310.00 per term',
            price_quote: 'Birthday party room rental (2 hrs) ....... $310.00',
            source_name: 'Cartwheels Gym Centre',
            source_url: 'https://cartwheelsgymcentre.example/programs',
          },
        ],
      };

    // The registration leg never ran, and the answer says when registration opens anyway.
    case 'invent_registration':
      return {
        slots: [
          {
            name: 'Parent & Tot 1, Gellert Community Centre',
            age_fit: 'parent and tot',
            when: 'Mondays 10:00-10:30 AM, Oct 05 - Dec 07',
            when_quote: 'Parent & Tot 1 | Mon | 10:00-10:30 AM | Oct 05 - Dec 07',
            price: '$86.22 for nine lessons',
            price_quote: 'Resident fee: $86.22 for nine lessons.',
            registration: 'Registration is not open yet',
            registration_quote: 'Resident fee: $86.22 for nine lessons.',
            source_name: 'Town of Halton Hills',
            source_url: 'https://haltonhills.example/gellert/aquatics',
          },
        ],
      };

    // The page was cut before the fee table and the answer has a fee on it.
    case 'invent_price':
      return {
        slots: [
          {
            name: 'Tiny Tumblers, Riverbend Community Centre',
            age_fit: '12 months - 4 years',
            when: 'Tuesdays 9:30-10:15 AM, September 8 to December 11',
            when_quote: 'Tiny Tumblers | Tue | 9:30-10:15 AM | 12 months - 4 yrs',
            price: '$185 per term',
            price_quote: 'FEES (per term) Tiny Tumblers .... $185.00',
            source_name: 'Riverbend Community Centre',
            source_url: 'https://riverbend.example/programs',
          },
        ],
      };

    // A school-age class handed back for a toddler question.
    default:
      return {
        slots: [
          {
            name: 'Level 1 Recreational, Georgetown Gymnastics Club',
            age_fit: 'ages 7-10',
            when: 'Thursdays 5:00-6:00 PM',
            when_quote: 'Level 1 Recreational | Thu | 5:00-6:00 PM | ages 7-10',
            source_name: 'Georgetown Gymnastics Club',
            source_url: 'https://georgetowngym.example/programs',
          },
        ],
      };
  }
}

// ── the live call ────────────────────────────────────────────────────────────

/**
 * STREAMED, and with the lane's knobs on the body, because that is the request production
 * makes. `cachedToolCall` in the shared harness posts a plain `messages.create` with no
 * `thinking` and no `output_config`; on an `xhigh` Opus lane over nine pages that is a
 * different request and, at this size, one that may not produce a header before the
 * client gives up (activity/synthesis.ts, and deep.ts on the un-streamed research turn).
 */
async function cachedSynthesis(opts) {
  const { tag, lane, system, userMessage, cachedOnly, getClient, cost } = opts;
  const canonical = JSON.stringify({
    lane,
    system,
    userMessage,
    toolName: 'activity_synthesis',
    toolSchema: SYNTHESIS_TOOL_SCHEMA,
  });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return { value: cached.value, latencyMs: cached.latencyMs, cached: true };
  if (cachedOnly) {
    console.error(
      `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
    );
    process.exit(1);
  }

  const startedAt = Date.now();
  const response = await getClient()
    .messages.stream({
      ...lane,
      max_tokens: SYNTHESIS_MAX_TOKENS,
      system,
      tools: [
        {
          name: 'activity_synthesis',
          description: 'Return the merged slots, each fact beside the span it was read off.',
          input_schema: SYNTHESIS_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'activity_synthesis' },
      messages: [{ role: 'user', content: userMessage }],
    })
    .finalMessage();
  const latencyMs = Date.now() - startedAt;
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`${tag}: tool call truncated at max_tokens (${SYNTHESIS_MAX_TOKENS})`);
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === 'activity_synthesis',
  );
  if (!toolUse) throw new Error(`${tag}: model returned no activity_synthesis tool call`);
  noteUsage(cost, response.model ?? lane.model, response.usage);
  await cachePut(key, { value: toolUse.input, latencyMs });
  return { value: toolUse.input, latencyMs, cached: false };
}

// ── the gates ────────────────────────────────────────────────────────────────

/** Every schedule fact that survived, as one lowercase haystack. */
function keptText(slots) {
  return slots
    .flatMap((slot) => [slot.name, slot.ageFit, slot.when, slot.price, slot.registration])
    .filter((value) => typeof value === 'string')
    .join(' | ')
    .toLowerCase();
}

/** What the model ASSERTED, before the refutation dropped anything — the haystack the
 * fabrication gates read, because a claim that was made and then refused is still a claim
 * the skill should not have made. */
function assertedText(rows) {
  return (rows ?? [])
    .flatMap((row) => [row.when, row.price, row.registration])
    .filter((value) => typeof value === 'string')
    .join(' | ')
    .toLowerCase();
}

function score(fixture, rows) {
  const byPage = pagesFrom(fixture.legs);
  const { slots, slotRefusals, factRefusals } = refuteSlots(rows, byPage);
  const failures = [];

  // THE CENTRAL GATE. Production drops an unquotable fact silently, so a merge that
  // produces them at any rate looks identical to a merge that found nothing.
  if (factRefusals.length > 0) {
    failures.push(`unquotable fact(s): ${factRefusals.join(', ')}`);
  }
  if (slotRefusals.length > 0) {
    failures.push(`refused slot(s): ${slotRefusals.join(', ')}`);
  }

  const kept = keptText(slots);
  for (const term of fixture.mustCarry ?? []) {
    if (!kept.includes(term.toLowerCase())) failures.push(`dropped a fact on the page: ${term}`);
  }
  // Read against what was ASSERTED, not what survived: the party-room rental and the
  // invented registration date are both claims the skill must not make, and both would
  // be invisible here if the refutation had already swept them up.
  const asserted = assertedText(rows);
  for (const term of fixture.mustNotCarry ?? []) {
    if (asserted.includes(term.toLowerCase())) failures.push(`claimed what no page said: ${term}`);
  }
  for (const field of fixture.mustNotFill ?? []) {
    if ((rows ?? []).some((row) => typeof row[field] === 'string' && row[field].trim() !== '')) {
      failures.push(`filled ${field} from a leg that opened nothing`);
    }
  }

  if (typeof fixture.minSlots === 'number' && slots.length < fixture.minSlots) {
    failures.push(`kept ${slots.length} slots, expected at least ${fixture.minSlots}`);
  }
  if (typeof fixture.maxSlots === 'number' && (rows ?? []).length > fixture.maxSlots) {
    failures.push(`returned ${(rows ?? []).length} slots, expected at most ${fixture.maxSlots}`);
  }

  return { failures, slots, slotRefusals, factRefusals };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SYNTHESIS_SKILL);
  const lane = agent.laneRequestFields(agent.pickLane(skill.meta.task));

  console.log(
    `activity-synthesis eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | lane=${JSON.stringify(lane)}`,
  );
  console.log(`corpus: ${SYNTHESIS_FIXTURES.length} merges\n`);

  const results = [];
  for (const fixture of SYNTHESIS_FIXTURES) {
    let rows;
    let latencyMs = 0;
    let cachedHit = false;
    if (broken) {
      rows = brokenSynthesis(fixture).slots;
    } else {
      const call = await cachedSynthesis({
        tag: `activity-synthesis:${fixture.id}`,
        lane,
        system: skill.instructions,
        userMessage: synthesisUserMessage(fixture),
        cachedOnly,
        getClient,
        cost,
      });
      rows = call.value.slots;
      latencyMs = call.latencyMs;
      cachedHit = call.cached;
    }

    const { failures, slots, slotRefusals, factRefusals } = score(fixture, rows);
    results.push({ fixture, failures, slots, slotRefusals, factRefusals, latencyMs, cachedHit });

    const mark = failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${mark}  ${fixture.id.padEnd(26)} rows=${(rows ?? []).length} kept=${slots.length} factRefusals=${factRefusals.length} slotRefusals=${slotRefusals.length}${cachedHit ? ' (cached)' : ` ${latencyMs}ms`}`,
    );
    for (const failure of failures) console.log(`      - ${failure}`);
  }

  const passing = results.filter((result) => result.failures.length === 0);
  console.log(`\n${passing.length}/${results.length} fixtures pass`);
  const spend = totalUsd(cost);
  if (spend > 0) console.log(`spend: $${spend.toFixed(4)}`);

  if (!broken) {
    const allPass = passing.length === results.length;
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  // CALIBRATION: every fixture's broken stand-in must be rejected, not merely one of them
  // — the modes are per fixture precisely so that each gate is seen to fire.
  const calibrated = passing.length === 0;
  console.log(
    `overall (broken): ${calibrated ? 'PASS (every stand-in rejected, exit 0)' : `FAIL (${passing.length} slipped through, exit 1)`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
