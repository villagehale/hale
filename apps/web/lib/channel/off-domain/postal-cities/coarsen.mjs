// Builds coarsen.json: which checked-in place names are official villages, and the
// nearest city in the same province or state to send instead on a sensitive search.
//
//   node coarsen.mjs <cgn_canada_csv_eng.csv> <2024_Gaz_place_national.txt>
//
// Reads ca.json and us.json beside itself. Writes coarsen.json beside itself.
// The downloads are untrusted data: this script reads them as text and evaluates
// none of it. It makes no network call.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A village farther than this from every city in its province or state is sent as
 * that province or state, with no municipality. */
const CAP_KM = 150;

const CGNDB_PROVINCE = {
  'Northwest Territory': 'Northwest Territories',
  'Nunavut Territory': 'Nunavut',
};

/** Concise codes that are incorporated municipalities, and how they rank. A name that
 * also has a larger class is that class: only a name whose best class is VILG is a
 * village. MUN1 and MUN2 are municipal districts and the like, larger than a village. */
const CA_RANK = { CITY: 3, TOWN: 2, MUN1: 2, MUN2: 2, VILG: 1 };

/** Census LSAD codes. 57 (CDP) is not a village and is not read. A borough or a town
 * outranks a village, so a name that is both is not coarsened. */
const US_RANK = { 25: 3, 21: 2, 43: 2, 47: 1 };
const US_TAIL = { 25: ' city', 21: ' borough', 43: ' town', 47: ' village' };

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
  return { table, spelling, shared };
}

/** One feature per folded name and region: the highest rank, then the highest
 * relevance, then the first coordinates seen. */
function consider(features, key, rank, lat, lon, relevance) {
  const before = features.get(key);
  if (
    before === undefined ||
    rank > before.rank ||
    (rank === before.rank && relevance > before.relevance)
  ) {
    features.set(key, { rank, lat, lon, relevance });
  }
}

function nearestCity(village, cities, spelling, shared) {
  let best = null;
  for (const city of cities) {
    if (city.key === village.key) continue;
    const distance = kilometres(village, city);
    const name = spelling.get(city.key);
    if (name === undefined) continue;
    if (
      best === null ||
      distance < best.distance - 1e-6 ||
      (Math.abs(distance - best.distance) <= 1e-6 && name.localeCompare(best.name) < 0)
    ) {
      best = { distance, name, key: city.key };
    }
  }
  if (best === null || best.distance > CAP_KM) return { city: null, province: null };
  return {
    city: best.name,
    province: shared.has(best.key) ? village.region : null,
  };
}

function entriesFor(features, rankOfVillage, citiesByRegion, spelling, shared, regionOf) {
  const entries = [];
  let withCity = 0;
  let regionOnly = 0;
  for (const [key, feature] of features) {
    if (feature.rank !== rankOfVillage) continue;
    const tab = key.indexOf('\t');
    const name = key.slice(0, tab);
    const region = regionOf(key.slice(tab + 1));
    if (!spelling.has(name)) continue;
    const nearest = nearestCity(
      { ...feature, key: name, region },
      citiesByRegion.get(region) ?? [],
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

async function readCanada(path) {
  const features = new Map();
  const input = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header = true;
  for await (const line of input) {
    if (header) {
      header = false;
      continue;
    }
    if (line === '') continue;
    const row = parseCsv(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    const rank = CA_RANK[row[7]];
    if (rank === undefined) continue;
    const lat = Number(row[9]);
    const lon = Number(row[10]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const region = CGNDB_PROVINCE[row[12]] ?? row[12];
    const relevance = Number(row[13]);
    consider(features, `${fold(row[1])}\t${region}`, rank, lat, lon, relevance);
  }
  return features;
}

async function readUnitedStates(path) {
  const features = new Map();
  const input = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header = true;
  for await (const line of input) {
    if (header) {
      header = false;
      continue;
    }
    if (line === '') continue;
    const row = line.split('\t').map((cell) => cell.trim());
    if (row[5] !== 'A') continue;
    const rank = US_RANK[row[4]];
    if (rank === undefined) continue;
    const tail = US_TAIL[row[4]];
    const named = row[3].toLowerCase().endsWith(tail) ? row[3].slice(0, -tail.length) : row[3];
    const lat = Number(row[10]);
    const lon = Number(row[11]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    consider(features, `${fold(named)}\t${row[0]}`, rank, lat, lon, 0);
  }
  return features;
}

function citiesByRegion(features, cityRank, regionName) {
  const byRegion = new Map();
  for (const [key, feature] of features) {
    if (feature.rank !== cityRank) continue;
    const tab = key.indexOf('\t');
    const name = key.slice(0, tab);
    const region = regionName(key.slice(tab + 1));
    const list = byRegion.get(region);
    const point = { key: name, lat: feature.lat, lon: feature.lon };
    if (list === undefined) byRegion.set(region, [point]);
    else list.push(point);
  }
  return byRegion;
}

const [cgnPath, gazPath] = process.argv.slice(2);
if (!cgnPath || !gazPath) {
  console.error('usage: node coarsen.mjs <cgn_canada_csv_eng.csv> <2024_Gaz_place_national.txt>');
  process.exit(1);
}

const ca = loadPostal('ca.json');
const us = loadPostal('us.json');
const caFeatures = await readCanada(cgnPath);
const usFeatures = await readUnitedStates(gazPath);

const stateName = new Map(
  us.table.regionCodes.map((code, index) => [code, us.table.regions[index]]),
);
const canada = entriesFor(
  caFeatures,
  CA_RANK.VILG,
  citiesByRegion(caFeatures, CA_RANK.CITY, (region) => region),
  ca.spelling,
  ca.shared,
  (region) => region,
);
const states = entriesFor(
  usFeatures,
  US_RANK[47],
  citiesByRegion(usFeatures, US_RANK[25], (code) => stateName.get(code) ?? code),
  us.spelling,
  us.shared,
  (code) => stateName.get(code) ?? code,
);

const coarsen = { capKm: CAP_KM, CA: canada.entries, US: states.entries };
const json = `${JSON.stringify(coarsen)}\n`;
writeFileSync(join(HERE, 'coarsen.json'), json);
const sha = createHash('sha256').update(json).digest('hex');
console.log(
  `CA villages ${canada.entries.length} (city ${canada.withCity}, region ${canada.regionOnly})`,
);
console.log(
  `US villages ${states.entries.length} (city ${states.withCity}, region ${states.regionOnly})`,
);
console.log(`coarsen.json sha256 ${sha}`);
