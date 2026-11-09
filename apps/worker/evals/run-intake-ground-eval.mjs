// The intake grounding searches eval (hard rule #8: no LLM mocking; VIL-592).
//
// The subjects are the two REAL skills a mid-signup question is searched on:
// intake-live-ground.md (raising-kids, a current fact, a therapist find) and
// intake-official-ground.md (a rec or camp date). Their notes are what the parent reads:
// live-lookup.ts and official-page.ts send the first sentences of them as the SMS. The
// request is production's own: the user message comes from
// apps/web/lib/channel/intake/ground-message.ts, which imports nothing, and the skill
// bodies and the model routing are imported live from packages/agent, so a skill edit or
// a re-tiering re-keys the cache and shows up as a miss.
//
// Usage (from apps/worker):
//   HALE_SPEND_LEDGER=... node --env-file=../../.env evals/run-intake-ground-eval.mjs --max-usd=2
//   node evals/run-intake-ground-eval.mjs --broken        # calibration: must FAIL, offline
//   node evals/run-intake-ground-eval.mjs --cached-only   # CI: replay only
//
// THE HARD ZEROS (a single one fails the gate):
//   · not grounded - the search returned no results. The runtime sends nothing from it.
//   · other country - a family whose country the search was told was handed the other
//     country's source: a Canadian page, a province, or 811 for a US family (811 is the
//     US call-before-you-dig line), or a US government page for a Canadian family.
//   · labelled - the notes open with a heading, a label or a list number. The runtime
//     sends their first sentence or two, so the parent would read the label.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  cacheGet,
  cacheKey,
  cachePut,
  evalRunTag,
  installEvalSpendCap,
  isMain,
  lazyAnthropic,
  makeCost,
  noteUsage,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const GROUND_MESSAGE_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'intake',
  'ground-message.ts',
);

// Matches the runtime: live-lookup.ts and answer.ts (groundOfficialPages).
const SKILL = {
  live: { file: 'intake-live-ground.md', maxSearches: 2, maxTokens: 2048 },
  official: { file: 'intake-official-ground.md', maxSearches: 2, maxTokens: 2048 },
};

const US = { countryName: 'United States' };
const CA = { countryName: 'Canada' };

/** Every question is invented and already de-identified, as deidentifyLiveQuery hands it on. */
export const FIXTURES = [
  {
    id: 'us-therapist-find',
    skill: 'live',
    question: 'where can I find a therapist for my postpartum anxiety',
    place: { ...US, provinceOrState: 'Washington' },
  },
  {
    id: 'us-nap',
    skill: 'live',
    question: 'how many naps should a 10 month old take',
    place: { ...US, provinceOrState: 'Texas' },
  },
  {
    id: 'us-swim-registration',
    skill: 'official',
    question: 'when does summer swim lesson registration open',
    place: { ...US, provinceOrState: 'Ohio' },
  },
  {
    id: 'ca-therapist-find',
    skill: 'live',
    question: 'where can I find a therapist for my postpartum anxiety',
    place: { ...CA, provinceOrState: 'British Columbia' },
  },
];

/**
 * A source that belongs to the other country. Not the country's bare name: a US service
 * that also covers Canada ("providers in the United States and Canada") is a US source.
 */
const CANADIAN_SOURCE =
  /\b(?:health canada|canada\.ca|ontario|british columbia|alberta|quebec|manitoba|saskatchewan|nova scotia|new brunswick|caring for kids|canadian paediatric society|health ?link|health ?811|811)\b/i;
const US_SOURCE = /\b(?:CDC|centers for disease control|healthychildren\.org)\b/i;

/** A first sentence that is a heading, a label, or a list number, not an answer. */
const LABELLED = /^\s*(?:#|\*|-|\d+[.)]|(?:research\s+)?notes?\b|[^.!?\n]{0,80}:\s)/i;

export function labelled(notes) {
  return !/^NO CURRENT SOURCE/i.test(notes.trim()) && LABELLED.test(notes);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** What the notes cite or say that belongs to the other country, or null. */
export function otherCountry(countryName, notes, citedUrls) {
  const hosts = citedUrls.map(hostOf);
  if (countryName === US.countryName) {
    const host = hosts.find((h) => h.endsWith('.ca'));
    if (host) return `cites ${host}`;
    const word = notes.match(CANADIAN_SOURCE);
    return word ? `says "${word[0]}"` : null;
  }
  const host = hosts.find((h) => h.endsWith('.gov'));
  if (host) return `cites ${host}`;
  const word = notes.match(US_SOURCE);
  return word ? `says "${word[0]}"` : null;
}

function readResearch(content) {
  let searchResults = 0;
  const notes = [];
  const citedUrls = [];
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      searchResults += block.content.length;
    }
    if (block.type !== 'text') continue;
    notes.push(block.text);
    for (const citation of block.citations ?? []) {
      if (typeof citation.url === 'string') citedUrls.push(citation.url);
    }
  }
  return { searchResults, notes: notes.join('').trim(), citedUrls };
}

async function cachedGround({
  tag,
  model,
  skill,
  system,
  userMessage,
  cachedOnly,
  getClient,
  cost,
}) {
  const canonical = JSON.stringify({ model, system, userMessage, tool: 'web_search_20250305' });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (cachedOnly) {
    console.error(
      `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
    );
    process.exit(1);
  }
  const response = await getClient().messages.create({
    model,
    max_tokens: skill.maxTokens,
    system,
    tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: skill.maxSearches }],
    messages: [{ role: 'user', content: userMessage }],
  });
  noteUsage(cost, model, response.usage);
  cost.searches =
    (cost.searches ?? 0) + (response.usage?.server_tool_use?.web_search_requests ?? 0);
  const value = readResearch(response.content);
  await cachePut(key, value);
  return value;
}

/** A US family handed Canada's sources: what the gate exists to refuse. */
const BROKEN_RESEARCH = {
  searchResults: 3,
  notes:
    'Notes: Ontario offers free counselling through ConnexOntario. Call Health811 any time to speak with a nurse.',
  citedUrls: ['https://www.ontario.ca/page/mental-health-services'],
};

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('intake-ground');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { groundUserMessage } = await tsImport(GROUND_MESSAGE_SRC, import.meta.url);

  const failures = [];
  for (const fixture of FIXTURES) {
    const skill = SKILL[fixture.skill];
    const loaded = await agent.loadSkill(join(SKILLS, skill.file));
    const model = agent.pickModel(loaded.meta.task);
    const research =
      broken && fixture.place.countryName === US.countryName
        ? BROKEN_RESEARCH
        : await cachedGround({
            tag: evalRunTag(`intake-ground:${fixture.id}`),
            model,
            skill,
            system: loaded.instructions,
            userMessage: groundUserMessage(fixture.question, fixture.place),
            cachedOnly: cachedOnly || broken,
            getClient,
            cost,
          });
    const wrong = otherCountry(fixture.place.countryName, research.notes, research.citedUrls);
    const reasons = [
      ...(research.searchResults === 0 ? ['not grounded'] : []),
      ...(wrong ? [`other country: ${wrong}`] : []),
      ...(labelled(research.notes) ? ['labelled'] : []),
    ];
    if (reasons.length > 0) failures.push(`${fixture.id}: ${reasons.join('; ')}`);
    console.info(
      `${reasons.length === 0 ? 'PASS' : 'FAIL'} ${fixture.id} (${fixture.skill}, ${model}) | results=${research.searchResults} cited=${research.citedUrls.length}`,
    );
    console.info(`  notes: ${research.notes.replace(/\s+/g, ' ').slice(0, 400)}`);
  }

  console.info(
    `\nintake-ground eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''}`,
  );
  console.info(
    `live API calls this run: ${cost.liveCalls} | web searches: ${cost.searches ?? 0} | estimated token cost this run: $${totalUsd(cost).toFixed(4)} USD (searches are $0.01 each on top)`,
  );
  console.info('\n--- gate ---');
  for (const failure of failures) console.info(`  ${failure}`);
  if (broken) {
    const bit = failures.length > 0;
    console.info(`calibration (broken): ${bit ? 'gate bit - PASS' : 'gate did not bite - FAIL'}`);
    process.exit(bit ? 0 : 1);
  }
  console.info(`overall (real): ${failures.length === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
