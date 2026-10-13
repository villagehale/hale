// Builds coarsen.json: which checked-in place names are under 10,000 people, and the
// nearest place of 10,000 or more in the same province or state to send instead.
//
//   node coarsen.mjs <98100002.csv> <cgn_canada_csv_eng.csv> <dir of *2020.pl.zip>
//
// Canada is the 2021 Census population of census subdivisions (Statistics Canada table
// 98-10-0002) with coordinates from the Geographical Names Data Base. The United States
// is the 2020 Census Redistricting Data (P.L. 94-171) table P1 total, from each state's
// `*2020.pl.zip`: places (summary level 160, census designated places included) and
// county subdivisions (summary level 060). A name that is both takes the higher count.
//
// Reads ca.json and us.json beside itself. Writes coarsen.json beside itself.
// The downloads are untrusted data: this script reads them as text and evaluates
// none of it. It makes no network call.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A place farther than this from every place of 10,000 or more in its province or
 * state is sent as that province or state, with no municipality. */
const CAP_KM = 150;
const FLOOR = 10_000;

const CGNDB_PROVINCE = {
  'Northwest Territory': 'Northwest Territories',
  'Nunavut Territory': 'Nunavut',
};

/** Statistics Canada province and territory codes, to the names the postal table uses. */
const CA_PR = {
  10: 'Newfoundland and Labrador',
  11: 'Prince Edward Island',
  12: 'Nova Scotia',
  13: 'New Brunswick',
  24: 'Quebec',
  35: 'Ontario',
  46: 'Manitoba',
  47: 'Saskatchewan',
  48: 'Alberta',
  59: 'British Columbia',
  60: 'Yukon',
  61: 'Northwest Territories',
  62: 'Nunavut',
};

const fold = (text) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

function kilometres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function loadPostal(file) {
  const table = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  const spelling = new Map();
  for (const city of table.cities) {
    const key = fold(city);
    if (!spelling.has(key)) spelling.set(key, city);
  }
  const shared = new Set();
  for (const index of table.sharedCities) shared.add(fold(table.cities[index]));
  const stateName = new Map(
    (table.regionCodes ?? []).map((code, index) => [code, table.regions[index]]),
  );
  // Where the postal table itself puts each name. A census namesake in some other
  // province or state is not a place this table would send, and must not become the
  // only match for a name the table uses in one region (Toronto, Ontario).
  const inRegion = new Map();
  for (let i = 0; i < table.codes.length; i++) {
    const city = table.cityOf[i];
    const region = table.regionOf[i];
    if (city < 0 || region < 0) continue;
    const key = fold(table.cities[city]);
    const name = table.regions[region];
    const set = inRegion.get(key);
    if (set === undefined) inRegion.set(key, new Set([name]));
    else set.add(name);
  }
  return { spelling, shared, stateName, inRegion };
}

function parseCsv(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

async function linesOf(path) {
  return createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
}

/** One point per folded name and region: the highest population, and its coordinates.
 * A census place and a county subdivision of the same name are one name: the larger
 * count is the one a search would be naming. */
function consider(features, key, pop, lat, lon) {
  const before = features.get(key);
  if (
    before === undefined ||
    pop > before.pop ||
    (pop === before.pop && before.lat === null && lat !== null)
  ) {
    features.set(key, { pop, lat, lon, place: true });
  }
}

function nearestLarge(small, larges, spelling, shared) {
  let best = null;
  for (const large of larges) {
    if (large.key === small.key) continue;
    if (large.lat === null || small.lat === null) continue;
    const distance = kilometres(small, large);
    const name = spelling.get(large.key);
    if (name === undefined) continue;
    if (
      best === null ||
      distance < best.distance - 1e-6 ||
      (Math.abs(distance - best.distance) <= 1e-6 && name.localeCompare(best.name) < 0)
    ) {
      best = { distance, name, key: large.key };
    }
  }
  if (best === null || best.distance > CAP_KM) return { city: null, province: null };
  return { city: best.name, province: shared.has(best.key) ? small.region : null };
}

function entriesFor(features, spelling, shared, inRegion) {
  const largesByRegion = new Map();
  for (const [key, feature] of features) {
    if (!(feature.pop >= FLOOR)) continue;
    const tab = key.indexOf('\t');
    const name = key.slice(0, tab);
    if (!spelling.has(name)) continue;
    const region = key.slice(tab + 1);
    const list = largesByRegion.get(region);
    const point = { key: name, lat: feature.lat, lon: feature.lon };
    if (list === undefined) largesByRegion.set(region, [point]);
    else list.push(point);
  }
  const entries = [];
  let withCity = 0;
  let regionOnly = 0;
  for (const [key, feature] of features) {
    if (feature.pop >= FLOOR) continue;
    const tab = key.indexOf('\t');
    const name = key.slice(0, tab);
    if (!spelling.has(name)) continue;
    const region = key.slice(tab + 1);
    // A name the postal table pins to specific regions is coarsened only there.
    // A name it lists and never pins (no area points at it) still coarsens: the
    // stored city can be that name, and every census region of it is small.
    const pinned = inRegion.get(name);
    if (pinned !== undefined && !pinned.has(region)) continue;
    const nearest = nearestLarge(
      { ...feature, key: name, region },
      largesByRegion.get(region) ?? [],
      spelling,
      shared,
    );
    if (nearest.city === null) regionOnly += 1;
    else withCity += 1;
    entries.push([spelling.get(name), region, nearest.city, nearest.province]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return { entries, withCity, regionOnly };
}

async function readCanadaPopulation(path) {
  const pop = new Map();
  let header = true;
  for await (const line of await linesOf(path)) {
    if (header) {
      header = false;
      continue;
    }
    if (line === '') continue;
    const row = parseCsv(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    const dguid = row[2] ?? '';
    if (!dguid.startsWith('2021A0005')) continue;
    const region = CA_PR[dguid.slice(9, 11)];
    if (region === undefined) continue;
    const count = Number(row[4]);
    // A suppressed count is not a place we can show is large.
    const people = Number.isFinite(count) ? count : 0;
    const key = `${fold(row[1])}\t${region}`;
    const before = pop.get(key);
    if (before === undefined || people > before) pop.set(key, people);
  }
  return pop;
}

async function readCanadaPoints(path) {
  const points = new Map();
  let header = true;
  for await (const line of await linesOf(path)) {
    if (header) {
      header = false;
      continue;
    }
    if (line === '') continue;
    const row = parseCsv(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    const lat = Number(row[9]);
    const lon = Number(row[10]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const region = CGNDB_PROVINCE[row[12]] ?? row[12];
    const relevance = Number(row[13]);
    const key = `${fold(row[1])}\t${region}`;
    const before = points.get(key);
    if (before === undefined || relevance > before.relevance) {
      points.set(key, { lat, lon, relevance });
    }
  }
  return points;
}

function canadaFeatures(pop, points) {
  const features = new Map();
  const keys = new Set([...pop.keys(), ...points.keys()]);
  for (const key of keys) {
    const people = pop.get(key);
    const point = points.get(key);
    // No census count: not a place we can show is large, so it is under the floor
    // when we at least know where it is. A count with no point can still be large
    // and is then not a place we replace; without a point it also cannot be a
    // destination, which the nearest-place step skips.
    const peopleKnown = people !== undefined;
    features.set(key, {
      pop: peopleKnown ? people : 0,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      place: true,
    });
  }
  return features;
}

function linesFromZip(zip, entry) {
  const child = spawn('unzip', ['-p', zip, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip ${zip} ${entry} exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
  return { lines, done };
}

async function readUnitedStates(dir, stateName) {
  const features = new Map();
  const zips = readdirSync(dir)
    .filter((name) => name.endsWith('2020.pl.zip'))
    .sort();
  for (const name of zips) {
    const abbr = name.slice(0, -'2020.pl.zip'.length);
    const zip = join(dir, name);
    const popByLog = new Map();
    const data = linesFromZip(zip, `${abbr}000012020.pl`);
    for await (const line of data.lines) {
      if (line === '') continue;
      const row = line.split('|');
      const count = Number(row[5]);
      if (Number.isFinite(count)) popByLog.set(row[4], count);
    }
    await data.done;
    const geo = linesFromZip(zip, `${abbr}geo2020.pl`);
    for await (const line of geo.lines) {
      if (line === '') continue;
      const row = line.split('|');
      const level = row[2];
      if (level !== '160' && level !== '060') continue;
      const status = row[88];
      if (status === 'F' || status === 'I') continue;
      const placeName = (row[86] ?? '').trim();
      if (placeName === '' || placeName.toLowerCase().startsWith('county subdivisions not')) {
        continue;
      }
      const region = stateName.get(abbr.toUpperCase());
      if (region === undefined) continue;
      const lat = Number((row[92] ?? '').replace('+', ''));
      const lon = Number((row[93] ?? '').replace('+', ''));
      const pop = popByLog.get(row[7]);
      if (pop === undefined) continue;
      consider(
        features,
        `${fold(placeName)}\t${region}`,
        pop,
        Number.isFinite(lat) && Number.isFinite(lon) ? lat : null,
        Number.isFinite(lat) && Number.isFinite(lon) ? lon : null,
      );
    }
    await geo.done;
  }
  return features;
}

const [statCanPath, cgnPath, plDir] = process.argv.slice(2);
if (!statCanPath || !cgnPath || !plDir) {
  console.error(
    'usage: node coarsen.mjs <98100002.csv> <cgn_canada_csv_eng.csv> <dir of *2020.pl.zip>',
  );
  process.exit(1);
}

const ca = loadPostal('ca.json');
const us = loadPostal('us.json');
const caPop = await readCanadaPopulation(statCanPath);
const caPoints = await readCanadaPoints(cgnPath);
const canada = entriesFor(canadaFeatures(caPop, caPoints), ca.spelling, ca.shared, ca.inRegion);
const states = entriesFor(
  await readUnitedStates(plDir, us.stateName),
  us.spelling,
  us.shared,
  us.inRegion,
);

const coarsen = {
  floor: FLOOR,
  capKm: CAP_KM,
  CA: canada.entries,
  US: states.entries,
};
const json = `${JSON.stringify(coarsen)}\n`;
writeFileSync(join(HERE, 'coarsen.json'), json);
const sha = createHash('sha256').update(json).digest('hex');
console.log(
  `CA under ${FLOOR}: ${canada.entries.length} (nearest ${canada.withCity}, region ${canada.regionOnly})`,
);
console.log(
  `US under ${FLOOR}: ${states.entries.length} (nearest ${states.withCity}, region ${states.regionOnly})`,
);
console.log(`coarsen.json sha256 ${sha}`);
