// VIL-684 — eval for the own-city registration lookup: for a family anywhere, find the
// city's own registration page by live search and read the season's opening off it.
//
// SUBJECT: the whole lookup as production runs it — the registration-page-search skill's
// streamed web_search turn, then the VIL-423 reader (the verify-registration-window skill
// and production's corroboration gate) on each page the search named, through
// lookupCityRegistration itself. The search request, the reader and the gate are
// production's own, imported rather than copied.
//
// THE HARD ZEROS (any one fails the gate):
//   · a date a city's page does not state: every quote a verified date stands on must
//     appear in the text of the page it was read off, and where the page's own
//     transcribed date is known (read by hand on 2026-11-12), the family's date must
//     equal it exactly;
//   · a date for a place with no such page: an invented town must come back not found,
//     never with a guessed date;
//   · a page that is not the city's own: the source must be on the city's own domain
//     (production now refuses it in code, through the official site the structured
//     source names; this check stays as the hand-read second line);
//   · a Toronto district family given another district's morning, or a free-centres or
//     early-local morning;
//   · a city that publishes its date today, and the lookup did not find it.
//
// Recorded RAW: the search turn's blocks (minus the opaque encrypted result payloads), the
// structured source's answers for the city's official site (Wikidata name search and
// place check, free), and each page's bytes as fetched by production's own pinned
// fetcher at record time, so a
// replay re-derives everything — the search outcome, the page text, the reading and the
// family's date — through today's code. The clock is pinned to the record day.
//
//   node evals/run-city-registration-eval.mjs --cached-only   # CI: replay, zero calls
//   node evals/run-city-registration-eval.mjs --broken        # calibration: must FAIL
//   .loop/bin/hale-live <slug> <cap> -- node evals/run-city-registration-eval.mjs --max-usd=<cap>

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cacheGet,
  cacheKey,
  cachePut,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  noteUsage,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const REGISTRATION = join(REPO_ROOT, 'apps', 'web', 'lib', 'registration');

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });
const importTs = (path) => import(pathToFileURL(path).href);
const agent = await importTs(AGENT_SRC);
const {
  MAX_PAGE_SEARCHES,
  PAGE_SEARCH_MAX_TOKENS,
  PAGE_SEARCH_SKILL,
  pageSearchOutcome,
  pageSearchUserMessage,
} = await importTs(join(REGISTRATION, 'city', 'search.ts'));
const { lookupCityRegistration } = await importTs(join(REGISTRATION, 'city', 'lookup.ts'));
const { lookupOfficialSite, wikidataSource } = await importTs(
  join(REGISTRATION, 'city', 'official-site.ts'),
);
const { familyOpening } = await importTs(join(REGISTRATION, 'city', 'opening.ts'));
const { winterRegistrationWindow } = await importTs(join(REGISTRATION, 'city', 'cycle.ts'));
const { createRegistrationReader } = await importTs(join(REGISTRATION, 'read.ts'));
const { createRegistrationPageBytesFetch } = await importTs(join(REGISTRATION, 'page.ts'));
const {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_MAX_TOKENS,
  extractionInput,
  normalizeQuote,
  parseExtraction,
} = await importTs(join(REGISTRATION, 'verify-window.ts'));

/** The record day. The search is told today's date, so the replay key pins it. */
const NOW = new Date('2026-11-12T20:00:00Z');
const CYCLE = 'Winter 2027';
const SEARCH_USD = 0.01;

const TORONTO_REGISTER =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/register-for-recreation-activities/';

const place = (city, provinceOrState, district = null) => ({
  city,
  provinceOrState,
  country: 'Canada',
  district,
  residencyKnown: true,
});

// Reference dates are transcribed by hand from each city's own page on 2026-11-12, keyed
// by the page they are printed on; never copied from what the model produced.
const FIXTURES = [
  {
    id: 'markham',
    why: 'A current family town. Residents and non-residents open on different mornings.',
    place: place('Markham', 'Ontario'),
    expect: 'find',
    host: 'markham.ca',
    // "2027 Winter Registration for residents: December 1, 2026, at 6:30 AM" /
    // "for non-residents: December 2, 2026, at 6:30 AM"
    reference: {
      'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information':
        { own: ['2026-12-01', '06:30'], general: ['2026-12-02', '06:30'] },
    },
  },
  // Toronto registers by district. The register page's table, read by hand 2026-11-12:
  // "Winter Recreation: Free Centres (for eligible residents) Tuesday, December 1, 7 a.m.
  //  Winter Recreation: Toronto, East York and Etobicoke Tuesday, December 8, 7 a.m.
  //  Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m."
  // It prints no year; production pins it from the printed weekday (Dec 8 2026 is a
  // Tuesday and Dec 9 a Wednesday; neither date is that weekday in 2027). The four
  // districts share one search: its input names no district.
  {
    id: 'toronto-north-york',
    why: 'A current family city that registers by district: North York opens on its own morning.',
    place: place('Toronto', 'Ontario', 'north_york'),
    expect: 'find',
    host: 'toronto.ca',
    reference: { [TORONTO_REGISTER]: { own: ['2026-12-09', '07:00'], general: null } },
  },
  {
    id: 'toronto-scarborough',
    why: "Scarborough shares North York's morning.",
    place: place('Toronto', 'Ontario', 'scarborough'),
    searchAs: 'toronto-north-york',
    expect: 'find',
    host: 'toronto.ca',
    reference: { [TORONTO_REGISTER]: { own: ['2026-12-09', '07:00'], general: null } },
  },
  {
    id: 'toronto-east-york',
    why: 'Toronto and East York open a day earlier than North York.',
    place: place('Toronto', 'Ontario', 'toronto_east_york'),
    searchAs: 'toronto-north-york',
    expect: 'find',
    host: 'toronto.ca',
    reference: { [TORONTO_REGISTER]: { own: ['2026-12-08', '07:00'], general: null } },
  },
  {
    id: 'toronto-etobicoke-york',
    why: 'Etobicoke shares the Toronto and East York morning.',
    place: place('Toronto', 'Ontario', 'etobicoke_york'),
    searchAs: 'toronto-north-york',
    // The recorded draw (2026-11-12) quoted its section by stitching two passages that are
    // not adjacent on the page, and the corroboration gate refused it, so this family
    // hears "doesn't know yet" until the next lookup. Not re-drawn (eval spend rule): the
    // hard zero here is a date the page does not state, and a find is graded on the page.
    expect: 'no_wrong_date',
    host: 'toronto.ca',
    reference: { [TORONTO_REGISTER]: { own: ['2026-12-08', '07:00'], general: null } },
  },
  {
    id: 'greater-sudbury',
    why: 'A family far from the GTA, with no hand-kept row anywhere: its own city, found live.',
    place: place('Greater Sudbury', 'Ontario'),
    expect: 'find',
    host: 'greatersudbury.ca',
    // "Winter Session 2027 – ten-week session Registration Date: December 16, 2026 at 8 a.m."
    reference: {
      'https://www.greatersudbury.ca/play/pools/swimming-lessons/program-registration-dates/': {
        own: ['2026-12-16', '08:00'],
        general: null,
      },
    },
  },
  // Outside the GTA, found live with no hand-kept anything. Both sites may refuse the
  // pinned fetcher (a bot challenge, a 403); the hard zero is a date the page does not
  // state, so "not found" with a named reason passes and a find is graded on the page.
  {
    id: 'ottawa',
    why: 'A family far from the GTA in a big city: its own page, or an honest not found.',
    place: place('Ottawa', 'Ontario'),
    expect: 'no_wrong_date',
    host: 'ottawa.ca',
  },
  {
    id: 'vancouver',
    why: 'A family in another province: its own page, or an honest not found.',
    place: place('Vancouver', 'British Columbia'),
    expect: 'no_wrong_date',
    host: 'vancouver.ca',
  },
  {
    id: 'winnipeg',
    why: 'A family in another province whose city site the pinned fetcher reads.',
    place: place('Winnipeg', 'Manitoba'),
    expect: 'find',
    host: 'winnipeg.ca',
    // Read by hand 2026-11-13, under "Our Fall 2026/Winter 2027 Leisure Guide":
    // "Registration for all fall and winter activities (with the exception of winter
    // swimming and skating) begins Tuesday, August 25 at 8 a.m. for Winnipeg residents,
    // and Thursday, August 27 at 8 a.m. for non-residents." Winter swimming and skating
    // open on their own, "Tuesday, December 15 at 8 a.m.", with no year printed. The
    // winter opening has already passed, so Hale tells nobody and looks no further.
    reference: {
      'https://www.winnipeg.ca/news/2026-08-13-city-winnipegs-fallwinter-leisure-guide-now-available':
        { own: ['2026-08-25', '08:00'], general: ['2026-08-27', '08:00'] },
    },
  },
  {
    id: 'invented-town',
    why: 'A town that does not exist has no page: Hale must say it does not know, never guess.',
    place: place('Fernwick Hollow', 'Ontario'),
    expect: 'unknown',
  },
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Only what production reads off a block: types, URLs, titles, text. The encrypted
 * result payloads are opaque and are not kept. */
function rawBlocks(content) {
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'web_search_tool_result') {
      return {
        type: block.type,
        content: Array.isArray(block.content)
          ? block.content.map((hit) => ({ type: hit.type, url: hit.url, title: hit.title }))
          : { type: block.content?.type, error_code: block.content?.error_code },
      };
    }
    return { type: block.type };
  });
}

/** The structured source production asks for a city's official site, its answers
 * recorded on the record day (free: Wikidata's public API). */
function cachedOfficialSiteSource(cachedOnly) {
  const live = wikidataSource();
  const cached = (kind, input, load) => async () => {
    const key = cacheKey(`city-registration:official-site:${kind}`, input);
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
    if (cachedOnly) {
      console.error(`cache miss in --cached-only mode (official site ${kind} ${input})`);
      process.exit(1);
    }
    const value = await load();
    await cachePut(key, value);
    return value;
  };
  return {
    search: (name) => cached('search', name, () => live.search(name))(),
    sparql: (query) => cached('sparql', query, () => live.sparql(query))(),
  };
}

async function cachedSearch({ fixture, skill, cachedOnly, getClient, cost }) {
  const model = agent.pickModel(skill.meta.task);
  const system = agent.cachedSystem(skill.instructions);
  const userMessage = pageSearchUserMessage(fixture.place, CYCLE, NOW.toISOString().slice(0, 10));
  const key = cacheKey(
    `city-registration:search:${fixture.searchAs ?? fixture.id}`,
    JSON.stringify({ model, system, userMessage, maxUses: MAX_PAGE_SEARCHES }),
  );
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (cachedOnly) {
    console.error(`cache miss in --cached-only mode (search ${fixture.id}, key ${key})`);
    process.exit(1);
  }
  const startedAt = Date.now();
  const response = await getClient()
    .messages.stream({
      model,
      max_tokens: PAGE_SEARCH_MAX_TOKENS,
      system,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_PAGE_SEARCHES }],
      messages: [{ role: 'user', content: userMessage }],
    })
    .finalMessage();
  noteUsage(cost, model, response.usage);
  const searches = response.usage.server_tool_use?.web_search_requests ?? 0;
  cost.webSearchRequests = (cost.webSearchRequests ?? 0) + searches;
  const value = {
    stopReason: response.stop_reason,
    content: rawBlocks(response.content),
    searches,
    latencyMs: Date.now() - startedAt,
    recordedAt: NOW.toISOString(),
  };
  await cachePut(key, value);
  return value;
}

/** A page's bytes as production's pinned fetcher saw them on the record day. */
async function cachedPage(url, cachedOnly) {
  const key = cacheKey('city-registration:page', url);
  const cached = await cacheGet(key);
  if (cached === undefined && cachedOnly) {
    console.error(`cache miss in --cached-only mode (page ${url}, key ${key})`);
    process.exit(1);
  }
  if (cached !== undefined) {
    return cached.outcome === 'fetched'
      ? { outcome: 'fetched', body: Buffer.from(cached.body, 'base64') }
      : cached;
  }
  const fetched = await createRegistrationPageBytesFetch()(url);
  const stored =
    fetched.outcome === 'fetched'
      ? { outcome: 'fetched', body: Buffer.from(fetched.body).toString('base64') }
      : fetched;
  await cachePut(key, stored);
  return fetched;
}

/** A reader that guesses: the stand-in the gate must reject. */
function brokenReader() {
  return async (target) => ({
    sourceUrl: target.sourceUrl,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: [
      {
        kind: 'unclassified_open',
        date: '2026-12-01',
        time: '07:00',
        evidence: ['Registration opens December 1 at 7 a.m.'],
      },
    ],
    partialDates: [],
  });
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only') || broken;
  installEvalSpendCap();
  const getClient = lazyAnthropic('city-registration');
  const cost = makeCost();
  const searchSkill = await agent.loadSkill(join(SKILLS, `${PAGE_SEARCH_SKILL}.md`));
  const readSkill = await agent.loadSkill(join(SKILLS, 'verify-registration-window.md'));
  const readLane = agent.pickLane(readSkill.meta.task);

  console.info(
    `city-registration eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | search=${agent.pickModel(searchSkill.meta.task)} read=${readLane.model}\n`,
  );

  const failures = [];
  const officialSites = cachedOfficialSiteSource(cachedOnly);
  for (const fixture of FIXTURES) {
    // The text the reader handed the model for the page being read now: the page a
    // verified date's quotes are checked against.
    let lastPageText = null;
    const reader = broken
      ? brokenReader()
      : createRegistrationReader(
          {
            fetchBody: (url) => cachedPage(url, cachedOnly),
            extract: async (cycle, pageText) => {
              lastPageText = pageText;
              const result = await cachedToolCall({
                tag: `city-registration:read:${fixture.id}`,
                model: readLane.model,
                lane: readLane,
                system: readSkill.instructions,
                userMessage: extractionInput(cycle, pageText),
                toolName: 'published_registration_window',
                toolDescription:
                  'Return the registration dates this page publishes for the named cycle.',
                toolSchema: EXTRACTION_JSON_SCHEMA,
                maxTokens: EXTRACTION_MAX_TOKENS,
                cachedOnly,
                getClient,
                cost,
              });
              return parseExtraction(result.value);
            },
          },
          // The own-city lane's reader, as production builds it (sweep.ts cityLookupDeps).
          { yearFromWeekday: winterRegistrationWindow },
        );
    const texts = new Map();
    const readAndKeep = async (target, now) => {
      lastPageText = null;
      const reading = await reader(target, now);
      texts.set(target.sourceUrl, lastPageText);
      return reading;
    };
    const search = async () => {
      const turn = await cachedSearch({
        fixture,
        skill: searchSkill,
        cachedOnly,
        getClient,
        cost,
      });
      if (turn.stopReason !== 'end_turn') {
        return { outcome: 'failed', reason: `stopped:${turn.stopReason}` };
      }
      return pageSearchOutcome(turn.content, fixture.place);
    };

    const found = await lookupCityRegistration(
      {
        officialSite: (where) => lookupOfficialSite(officialSites, where),
        search,
        read: readAndKeep,
      },
      fixture.place,
      CYCLE,
      NOW,
    );

    const reasons = [];
    let line = found.status;
    if (fixture.expect === 'unknown' && found.status === 'verified') {
      reasons.push(`a date for a place with no page: ${JSON.stringify(found.reading.dates)}`);
    }
    if (fixture.expect === 'find' && found.status !== 'verified') {
      reasons.push(`missed: ${JSON.stringify(found)}`);
    }
    if (found.status === 'verified') {
      const host = hostOf(found.sourceUrl);
      line = `verified ${found.sourceUrl}`;
      if (fixture.host && !(host === fixture.host || host.endsWith(`.${fixture.host}`))) {
        reasons.push(`not the city's own page: ${host}`);
      }
      const pageText = texts.get(found.sourceUrl);
      const page = pageText ? normalizeQuote(pageText) : '';
      for (const date of found.reading.dates) {
        for (const quote of date.evidence) {
          if (!page.includes(normalizeQuote(quote))) {
            reasons.push(`quote not on the page: "${quote}"`);
          }
        }
      }
      const opening = familyOpening(found.reading, fixture.place);
      if (opening === null) reasons.push('verified, but no opening for this family');
      const reference = fixture.reference?.[found.sourceUrl];
      if (opening && reference) {
        const own = [opening.own.date, opening.own.time];
        const general = opening.general ? [opening.general.date, opening.general.time] : null;
        if (JSON.stringify(own) !== JSON.stringify(reference.own)) {
          reasons.push(`own date ${own} != page ${reference.own}`);
        }
        if (JSON.stringify(general) !== JSON.stringify(reference.general)) {
          reasons.push(`general date ${general} != page ${reference.general}`);
        }
      }
      if (opening) {
        line += ` | own ${opening.own.kind} ${opening.own.date} ${opening.own.time ?? '(no time)'}${
          opening.general ? ` | general ${opening.general.date} ${opening.general.time}` : ''
        }${reference ? ' | reference page' : ' | page not hand-transcribed'}`;
      }
    } else if (found.status === 'not_found') {
      line = `not_found ${found.reason} ${JSON.stringify(found.tried)}`;
    }
    if (reasons.length > 0) failures.push(`${fixture.id}: ${reasons.join('; ')}`);
    console.info(`${reasons.length === 0 ? 'PASS' : 'FAIL'} ${fixture.id} | ${line}`);
  }

  const searches = cost.webSearchRequests ?? 0;
  console.info(
    `\nlive API calls this run: ${cost.liveCalls} | web searches: ${searches} | estimated cost: $${(totalUsd(cost) + searches * SEARCH_USD).toFixed(4)} USD`,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
