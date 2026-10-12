// Builds ca.json and us.json from the three public downloads README.md names.
//
//   node build.mjs <CA.txt> <US.txt> <cgn_canada_csv_eng.csv> [--review]
//
// The downloads are read as text and nothing else: no line of them is evaluated, and the
// script makes no network call. `--review` prints every Canadian area with what it was
// resolved to, for a reader to check the rule against, and writes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

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

/** README.md, "Canada". Returns a municipality's name, AMBIGUOUS or UNMAPPED. */
function canadianCity(row, municipalities) {
  if (row.code[1] === '0') return AMBIGUOUS;
  if (row.code[0] === 'M') return 'Toronto';
  const described = row.place.replace(/\s*\(.*$/, '');
  // "Rothesay, Quispamsis": the source itself lists two places.
  if (described.includes(',')) return AMBIGUOUS;
  const inProvince = municipalities.get(CGNDB_PROVINCE[row.province] ?? row.province) ?? [];
  const place = fold(described);
  const named = inProvince.filter(
    (municipality) =>
      place === municipality.folded || place.startsWith(`${municipality.folded} `),
  );
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

function table(byCode) {
  const codes = [...byCode.keys()].sort();
  const cities = [...new Set([...byCode.values()].filter((city) => typeof city === 'string'))].sort();
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
    `${label}: ${built.codes.length} areas, ${resolved} resolve to one city (${((100 * resolved) / built.codes.length).toFixed(1)}%), ${count(AMBIGUOUS)} ambiguous, ${count(UNMAPPED)} unmapped, ${built.cities.length} city names\n`,
  );
}

function main() {
  const [caPath, usPath, cgndbPath, flag] = process.argv.slice(2);
  if (!caPath || !usPath || !cgndbPath) {
    throw new Error('usage: node build.mjs <CA.txt> <US.txt> <cgn_canada_csv_eng.csv> [--review]');
  }
  const municipalities = readMunicipalities(cgndbPath);
  const caRows = readPostal(caPath);
  const ca = resolveAll(caRows, /^[A-Z]\d[A-Z]$/, (row) => canadianCity(row, municipalities));
  const us = resolveAll(readPostal(usPath), /^\d{5}$/, americanCity);

  if (flag === '--review') {
    for (const row of caRows) {
      const city = ca.get(row.code);
      process.stdout.write(
        `${row.code}\t${row.place}\t${city === AMBIGUOUS ? '(ambiguous)' : city === UNMAPPED ? '(unmapped)' : city}\n`,
      );
    }
    return;
  }
  const built = { ca: table(ca), us: table(us) };
  writeFileSync(join(HERE, 'ca.json'), `${JSON.stringify(built.ca)}\n`);
  writeFileSync(join(HERE, 'us.json'), `${JSON.stringify(built.us)}\n`);
  report('Canada', built.ca);
  report('United States', built.us);
}

main();
