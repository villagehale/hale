// Builds ca.json and us.json from the public sources README.md names.
//
//   node build.mjs --fetch <empty directory>
//   node build.mjs <CA.txt> <US.txt> <cgn_canada_csv_eng.csv> <that directory> [--review]
//
// `--fetch` downloads the three Statistics Canada boundary files the Canadian table also
// reads, and is the only part of this script that makes a network call. The build reads
// every download as text and nothing else: no line of one is evaluated. `--review` prints
// every Canadian area with what it was resolved to and, where the land decided it, how
// its land divides, for a reader to check the rule against, and writes nothing.

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `cityOf` for an area that covers more than one town. */
const AMBIGUOUS = -1;
/** `cityOf` for an area the rule could not reduce to one municipality. */
const UNMAPPED = -2;

/** How far a municipality's point may be from a postal area's point and still be the
 * municipality that area is named for. See README.md, "Canada", rule 4. */
const SAME_PLACE_KM = 25;

/** The CGNDB records that are incorporated municipalities. Everything else in its
 * populated-place category is a part of one (a neighbourhood, a former borough, a
 * community, a hamlet) or a region. */
const MUNICIPAL_CODES = new Set(['CITY', 'TOWN', 'VILG']);
const NOT_A_MUNICIPALITY = new Set(['Borough']);
const MUNICIPAL_DISTRICTS = new Set([
  'County',
  'County Municipality',
  'District Municipality',
  'Municipal County',
  'Municipal District',
  'Regional Municipality',
  'Resort Municipality',
  'Restructured County',
  'Rural Community',
  'Rural Municipality',
  'Specialized Municipality',
  'Township Municipality',
]);

/** GeoNames spells three territories its own way. */
const CGNDB_PROVINCE = {
  'Northwest Territory': 'Northwest Territories',
  'Nunavut Territory': 'Nunavut',
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

/** One CSV record. CGNDB quotes a field that holds a comma and doubles a quote inside it. */
function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/** province -> the incorporated municipalities CGNDB lists in it. */
function readMunicipalities(path) {
  const lines = readFileSync(path, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line !== '');
  const header = csvFields(lines[0]);
  const at = (name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`CGNDB: no "${name}" column`);
    return index;
  };
  const [name, term, category, code, lat, lon, province] = [
    'Geographical Name',
    'Generic Term',
    'Generic Category',
    'Concise Code',
    'Latitude',
    'Longitude',
    'Province - Territory',
  ].map(at);
  const byProvince = new Map();
  for (const line of lines.slice(1)) {
    const row = csvFields(line);
    if (row.length !== header.length) throw new Error('CGNDB: a record with the wrong field count');
    const municipal =
      (row[category] === 'Populated Place' &&
        MUNICIPAL_CODES.has(row[code]) &&
        !NOT_A_MUNICIPALITY.has(row[term])) ||
      ((row[code] === 'MUN1' || row[code] === 'MUN2') && MUNICIPAL_DISTRICTS.has(row[term]));
    if (!municipal) continue;
    const list = byProvince.get(row[province]) ?? [];
    list.push({
      name: row[name],
      folded: fold(row[name]),
      lat: Number(row[lat]),
      lon: Number(row[lon]),
    });
    byProvince.set(row[province], list);
  }
  return byProvince;
}

// ── Statistics Canada, 2021 Census cartographic boundary files (README.md, "Sources") ──

const SERVICE =
  'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer';
const FSA_LAYER = 14;
const CSD_LAYER = 9;
/** An urban forward sortation area: the second character is not 0. */
const URBAN = "CFSAUID NOT LIKE '_0_'";

/**
 * Every census subdivision outside Nunavut (province code 62). Nunavut has no urban area,
 * and the service cannot return its unorganized territories at all: one of them has
 * 124,000 km of coastline. `readLand` proves nothing was needed from there, by accounting
 * for all the land of every urban area.
 */
const NOT_NUNAVUT = "PRUID <> '62'";

/** What `--fetch` writes. A rural area's boundary is never read (it is ambiguous by
 * rule), and each one is megabytes of coastline, so only its id is fetched. */
const DOWNLOADS = [
  {
    file: 'fsa-all.ndjson',
    layer: FSA_LAYER,
    where: '1=1',
    key: 'CFSAUID',
    fields: ['CFSAUID', 'PRUID'],
    geometry: false,
  },
  {
    file: 'fsa-urban.ndjson',
    layer: FSA_LAYER,
    where: URBAN,
    key: 'CFSAUID',
    fields: ['CFSAUID', 'PRUID', 'SHAPE_Area'],
    geometry: true,
  },
  {
    file: 'csd.ndjson',
    layer: CSD_LAYER,
    where: NOT_NUNAVUT,
    key: 'CSDUID',
    fields: ['CSDUID', 'CSDNAME', 'CSDTYPE', 'PRUID'],
    geometry: true,
  },
];

const PAGE_ROWS = 100;
const ATTEMPTS = 8;
const PAUSE_MS = 5000;
const REQUEST_TIMEOUT_MS = 120_000;

/** How much of an urban area's land must lie in one census subdivision for the area to be
 * that municipality's. See README.md, "Canada", rule 5. */
const ONE_MUNICIPALITY_SHARE = 0.95;
/** Horizontal lines an area's land is measured along. See `landShares`. */
const SCANLINES = 2000;
/** How far the measured land of an area may be from the area the source states for it. */
const AREA_TOLERANCE = 0.005;

/**
 * Census subdivision types that are not municipalities: the "municipal equivalents" the
 * 2021 Census Dictionary lists (reserves, settlements, unorganized territory, and the
 * unincorporated parts of a county or regional district).
 */
const MUNICIPAL_EQUIVALENTS = new Set([
  'IRI',
  'S-É',
  'IGD',
  'NL',
  'TC',
  'TI',
  'TK',
  'TL',
  'NO',
  'SNO',
  'RDA',
  'SC',
  'LOT',
  'P',
  'SG',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to the map service. It answers HTTP 500 with an HTML page now and then, so
 * a failure is retried after a pause. A JSON body that says the query itself failed is a
 * page too large for it: `null`, and the caller asks for fewer rows.
 */
async function ask(url) {
  let last = '';
  let refused = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await response.text();
      if (response.status !== 200) last = `HTTP ${response.status}`;
      else {
        const parsed = JSON.parse(body);
        if (parsed.error === undefined) return parsed;
        last = `service error ${parsed.error.code}`;
        refused += 1;
        if (refused === 2) return null;
      }
    } catch (err) {
      last = err instanceof Error ? err.name : 'unknown';
    }
    await sleep(PAUSE_MS);
  }
  throw new Error(`Statistics Canada map service: gave up after ${ATTEMPTS} attempts (${last})`);
}

/**
 * Downloads one file, a page at a time and a row per line, and proves it complete against
 * the service's own count. Written as it arrives: the census subdivisions together are
 * larger than one string can hold.
 */
async function download(directory, { file, layer, where, key, fields, geometry }) {
  const query = `${SERVICE}/${layer}/query?where=${encodeURIComponent(where)}`;
  const counted = await ask(`${query}&returnCountOnly=true&f=json`);
  if (counted === null) throw new Error(`${file}: the service would not count its rows`);
  const path = join(directory, file);
  const digest = createHash('sha256');
  const ids = new Set();
  let fetched = 0;
  let rows = PAGE_ROWS;
  writeFileSync(path, '');
  while (fetched < counted.count) {
    const page = await ask(
      `${query}&outFields=${fields.join(',')}&orderByFields=OBJECTID&resultOffset=${fetched}&resultRecordCount=${rows}&returnGeometry=${geometry}&geometryPrecision=1&f=json`,
    );
    if (page === null) {
      if (rows === 1) throw new Error(`${file}: the service refuses row ${fetched} on its own`);
      rows = Math.ceil(rows / 2);
      continue;
    }
    if (page.features.length === 0) break;
    for (const feature of page.features) {
      const line = `${JSON.stringify(feature)}\n`;
      ids.add(feature.attributes[key]);
      digest.update(line);
      appendFileSync(path, line);
    }
    fetched += page.features.length;
    process.stdout.write(`${file}: ${fetched} of ${counted.count}\n`);
  }
  if (fetched !== counted.count || ids.size !== counted.count) {
    throw new Error(
      `${file}: fetched ${fetched} rows (${ids.size} distinct), the service counts ${counted.count}`,
    );
  }
  process.stdout.write(`${file}: complete, ${fetched} rows, sha256 ${digest.digest('hex')}\n`);
}

/** One downloaded row per line. Read as a stream: the census subdivisions are too large
 * for one string. */
async function* rowsOf(path) {
  for await (const line of createInterface({ input: createReadStream(path, 'utf8') })) {
    if (line !== '') yield JSON.parse(line);
  }
}

/**
 * A boundary as the overlay reads it: every edge that is not horizontal, lower end first,
 * and the box around them. Rings are not told apart: an inner ring is a hole because a
 * line crossing the boundary an even number of times is outside (see `crossings`).
 */
function boundary(rings) {
  const edges = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if (x1 < minX) minX = x1;
      if (x1 > maxX) maxX = x1;
      if (y1 < minY) minY = y1;
      if (y1 > maxY) maxY = y1;
      if (y1 < y2) edges.push(x1, y1, x2, y2);
      else if (y2 < y1) edges.push(x2, y2, x1, y1);
    }
  }
  return { edges: Float64Array.from(edges), minX, minY, maxX, maxY };
}

const overlaps = (a, b) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/**
 * Where a boundary crosses each of `count` horizontal lines, the first at `first` and
 * `step` apart: per line, the crossings sorted left to right. Between the 1st and 2nd
 * crossing a line is inside the boundary, between the 2nd and 3rd outside, and so on.
 */
function crossings(shape, first, step, count) {
  const lines = Array.from({ length: count }, () => []);
  const { edges } = shape;
  for (let i = 0; i < edges.length; i += 4) {
    const x1 = edges[i];
    const y1 = edges[i + 1];
    const x2 = edges[i + 2];
    const y2 = edges[i + 3];
    const from = Math.max(0, Math.ceil((y1 - first) / step));
    const to = Math.min(count - 1, Math.ceil((y2 - first) / step) - 1);
    for (let line = from; line <= to; line += 1) {
      const y = first + line * step;
      lines[line].push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  for (const line of lines) line.sort((a, b) => a - b);
  return lines;
}

/** The length two sets of inside-spans on one line have in common. */
function shared(a, b) {
  let length = 0;
  let i = 0;
  let j = 0;
  while (i + 1 < a.length && j + 1 < b.length) {
    const left = Math.max(a[i], b[j]);
    const right = Math.min(a[i + 1], b[j + 1]);
    if (right > left) length += right - left;
    if (a[i + 1] < b[j + 1]) i += 2;
    else j += 2;
  }
  return length;
}

/**
 * How an urban area's land divides among census subdivisions: `{ csd, share }`, largest
 * first, and the land itself in square metres.
 *
 * Measured, not clipped: the area is cut by SCANLINES evenly spaced horizontal lines, and
 * on each line the stretch inside the area is compared with the stretch inside each
 * subdivision whose box touches it. The boundaries are in Statistics Canada's Lambert
 * projection, in metres, so a length on a line times the spacing is land. No geometry
 * library, and the same input gives the same output on any machine.
 */
function landShares(area, subdivisions) {
  const step = (area.maxY - area.minY) / SCANLINES;
  const first = area.minY + step / 2;
  const own = crossings(area, first, step, SCANLINES);
  let land = 0;
  for (const line of own) land += shared(line, line);
  const shares = [];
  for (const csd of subdivisions) {
    if (!overlaps(area, csd)) continue;
    const theirs = crossings(csd, first, step, SCANLINES);
    let common = 0;
    for (let line = 0; line < SCANLINES; line += 1) common += shared(own[line], theirs[line]);
    if (common > 0) shares.push({ csd, share: common / land });
  }
  shares.sort((a, b) => b.share - a.share || (a.csd.id < b.csd.id ? -1 : 1));
  return { land: land * step, shares };
}

/**
 * Every area the boundary file has, and how the land of each urban one divides among
 * census subdivisions.
 */
async function readLand(directory) {
  const urban = new Map();
  for await (const row of rowsOf(join(directory, 'fsa-urban.ndjson'))) {
    urban.set(row.attributes.CFSAUID, {
      ...boundary(row.geometry.rings),
      stated: row.attributes.SHAPE_Area,
    });
  }
  const areas = [...urban.values()];
  const subdivisions = [];
  for await (const row of rowsOf(join(directory, 'csd.ndjson'))) {
    const shape = boundary(row.geometry.rings);
    // A subdivision no urban area's box touches is never measured against.
    if (!areas.some((area) => overlaps(area, shape))) continue;
    subdivisions.push({
      ...shape,
      id: row.attributes.CSDUID,
      // `Greater Sudbury / Grand Sudbury`: a name given in both languages, English first.
      name: row.attributes.CSDNAME.split(' / ')[0],
      municipal: !MUNICIPAL_EQUIVALENTS.has(row.attributes.CSDTYPE),
    });
  }

  const codes = [];
  const land = new Map();
  for await (const row of rowsOf(join(directory, 'fsa-all.ndjson'))) {
    const code = row.attributes.CFSAUID;
    codes.push(code);
    if (code[1] === '0') continue;
    const area = urban.get(code);
    if (area === undefined) throw new Error(`${code}: an urban area with no boundary`);
    const measured = landShares(area, subdivisions);
    if (Math.abs(measured.land - area.stated) > AREA_TOLERANCE * area.stated) {
      throw new Error(`${code}: measured ${measured.land} m2, the source states ${area.stated}`);
    }
    const accounted = measured.shares.reduce((sum, { share }) => sum + share, 0);
    if (Math.abs(accounted - 1) > AREA_TOLERANCE) {
      throw new Error(`${code}: the subdivisions account for ${accounted} of its land`);
    }
    land.set(code, measured.shares);
  }
  return { codes, land };
}

/**
 * README.md, "Canada", rule 5: an area the names could not place, placed by its land.
 * `named` are the municipalities its own description names, when it names any.
 *
 * The land is not believed over the name. T2P is downtown Calgary, and 98% of its
 * boundary is Rocky View County: the boundary takes in wherever a household reported the
 * code, and a post-office box in town can belong to a farm outside it.
 */
function cityByLand(shares, named) {
  const [most] = shares;
  if (most === undefined) return UNMAPPED;
  if (most.share < ONE_MUNICIPALITY_SHARE) return AMBIGUOUS;
  if (!most.csd.municipal) return UNMAPPED;
  const itsName = fold(most.csd.name);
  const contradicted = named.length > 0 && !named.some(({ folded }) => folded === itsName);
  return contradicted ? UNMAPPED : most.csd.name;
}

/** GeoNames postal rows: country, code, place, admin1 name and code, ..., lat, lon. */
function readPostal(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const row = line.split('\t');
      if (row.length !== 12) throw new Error('GeoNames: a row with the wrong field count');
      return {
        code: row[1],
        place: row[2],
        province: row[3],
        provinceCode: row[4],
        lat: Number(row[9]),
        lon: Number(row[10]),
      };
    });
}

const provinceOf = (row, municipalities) =>
  municipalities.get(CGNDB_PROVINCE[row.province] ?? row.province) ?? [];

/** The incorporated municipalities of its province that an area's description is, or
 * begins with, the name of. The description is read without any parenthesised part. */
function namedBy(row, municipalities) {
  const place = fold(row.place.replace(/\s*\(.*$/, ''));
  return provinceOf(row, municipalities).filter(
    (municipality) => place === municipality.folded || place.startsWith(`${municipality.folded} `),
  );
}

/** README.md, "Canada", rules 1 to 4. Returns a municipality's name, AMBIGUOUS or UNMAPPED. */
function canadianCity(row, municipalities) {
  if (row.code[1] === '0') return AMBIGUOUS;
  if (row.code[0] === 'M') return 'Toronto';
  // "Rothesay, Quispamsis": the source itself lists two places.
  if (row.place.replace(/\s*\(.*$/, '').includes(',')) return AMBIGUOUS;
  const inProvince = provinceOf(row, municipalities);
  const named = namedBy(row, municipalities);
  if (named.length === 0) return UNMAPPED;
  const longest = Math.max(...named.map((municipality) => municipality.folded.length));
  const [nearest] = named
    .filter((municipality) => municipality.folded.length === longest)
    .map((municipality) => ({ ...municipality, km: kilometres(row, municipality) }))
    .sort((a, b) => a.km - b.km);
  if (nearest.km > SAME_PLACE_KM) return UNMAPPED;
  // "Montreal East" is the town of Montréal-Est and "Kelowna West" is West Kelowna: a
  // nearer municipality whose own name holds this one's is the likelier owner.
  const shadowed = inProvince.some(
    (other) =>
      other.folded !== nearest.folded &&
      other.folded.split(/[^\p{L}\p{N}]+/u).includes(nearest.folded) &&
      kilometres(row, other) < nearest.km,
  );
  return shadowed ? UNMAPPED : nearest.name;
}

/** README.md, "United States". */
function americanCity(row) {
  if (row.provinceCode === '' || row.provinceCode === 'MH') return UNMAPPED;
  return row.place;
}

/** One resolution per code. A code the source lists twice with two answers is ambiguous. */
function resolveAll(rows, keyPattern, resolve) {
  const byCode = new Map();
  for (const row of rows) {
    if (!keyPattern.test(row.code)) continue;
    const city = resolve(row);
    const before = byCode.get(row.code);
    byCode.set(row.code, before === undefined || before === city ? city : AMBIGUOUS);
  }
  return byCode;
}

/** `alsoNamed` are place names the table holds although no area resolves to them. */
function table(byCode, alsoNamed = []) {
  const codes = [...byCode.keys()].sort();
  const cities = [
    ...new Set([...[...byCode.values()].filter((city) => typeof city === 'string'), ...alsoNamed]),
  ].sort();
  const cityOf = codes.map((code) => {
    const city = byCode.get(code);
    return typeof city === 'string' ? cities.indexOf(city) : city;
  });
  return { codes, cities, cityOf };
}

function report(label, built) {
  const count = (value) => built.cityOf.filter((city) => city === value).length;
  const resolved = built.cityOf.filter((city) => city >= 0).length;
  process.stdout.write(
    `${label}: ${built.codes.length} areas, ${resolved} resolve to one city (${((100 * resolved) / built.codes.length).toFixed(1)}%), ${count(AMBIGUOUS)} ambiguous, ${count(UNMAPPED)} unmapped, ${built.cities.length} place names\n`,
  );
}

const named = (city) =>
  city === AMBIGUOUS ? '(ambiguous)' : city === UNMAPPED ? '(unmapped)' : city;

async function main() {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--fetch' && rest.length === 1) {
    for (const file of DOWNLOADS) await download(rest[0], file);
    return;
  }
  const [usPath, cgndbPath, boundaries, flag] = rest;
  if (first === '--fetch' || !usPath || !cgndbPath || !boundaries) {
    throw new Error(
      'usage: node build.mjs --fetch <empty directory> | node build.mjs <CA.txt> <US.txt> <cgn_canada_csv_eng.csv> <that directory> [--review]',
    );
  }
  const municipalities = readMunicipalities(cgndbPath);
  const caRows = readPostal(first);
  const byName = resolveAll(caRows, /^[A-Z]\d[A-Z]$/, (row) => canadianCity(row, municipalities));
  const { codes, land } = await readLand(boundaries);

  // The names decide first. The land places only what they could not, and an area the
  // postal source does not list at all (README.md, "Canada").
  const rowOf = new Map(caRows.map((row) => [row.code, row]));
  const ca = new Map();
  const byLand = new Map();
  for (const code of new Set([...byName.keys(), ...codes])) {
    const byNameAlone = byName.get(code) ?? (code[1] === '0' ? AMBIGUOUS : UNMAPPED);
    if (byNameAlone === UNMAPPED && land.has(code)) {
      const row = rowOf.get(code);
      byLand.set(code, cityByLand(land.get(code), row ? namedBy(row, municipalities) : []));
    }
    ca.set(code, byLand.get(code) ?? byNameAlone);
  }

  if (flag === '--review') {
    const places = new Map(caRows.map((row) => [row.code, row.place]));
    for (const code of [...ca.keys()].sort()) {
      const shares = (land.get(code) ?? [])
        .slice(0, 3)
        .map(({ csd, share }) => `${csd.name} ${(100 * share).toFixed(1)}%`)
        .join(', ');
      process.stdout.write(
        `${code}\t${places.get(code) ?? ''}\t${named(ca.get(code))}\t${byLand.has(code) ? 'by land' : ''}\t${shares}\n`,
      );
    }
    return;
  }
  const everyMunicipality = [...municipalities.values()].flat().map(({ name }) => name);
  const built = {
    ca: table(ca, everyMunicipality),
    us: table(resolveAll(readPostal(usPath), /^\d{5}$/, americanCity)),
  };
  writeFileSync(join(HERE, 'ca.json'), `${JSON.stringify(built.ca)}\n`);
  writeFileSync(join(HERE, 'us.json'), `${JSON.stringify(built.us)}\n`);
  report('Canada', built.ca);
  const landed = [...byLand.values()];
  process.stdout.write(
    `Canada, by land: ${landed.length} areas the names left unmapped, ${landed.filter((city) => typeof city === 'string').length} resolve, ${landed.filter((city) => city === AMBIGUOUS).length} ambiguous, ${landed.filter((city) => city === UNMAPPED).length} unmapped\n`,
  );
  report('United States', built.us);
}

await main();
