#!/usr/bin/env node
/**
 * Regenerate apps/web/lib/companion/who-growth-data.ts from the official WHO Child
 * Growth Standards tables — the tamper-evident provenance chain for the committed
 * LMS data (task 20). It:
 *   1. reads the lock (lib/companion/who-growth-lms.lock.json): the 6 source URLs +
 *      their pinned byte sizes and md5s,
 *   2. downloads each file and HARD-FAILS on any md5/byte mismatch (so the data
 *      module can never be regenerated from a different or corrupted source),
 *   3. parses the day-resolution z-score "expanded tables" (xlsx = zip of XML,
 *      unzipped here with Node's zlib — no external dependency),
 *   4. downsamples to completed months at WHO Anthro's 30.4375 days/month, and
 *   5. writes who-growth-data.ts.
 *
 * Run: `node scripts/sync-who-growth.mjs` (needs network to who.int). Pass `--check`
 * to regenerate into memory and fail if it differs from the committed file (a CI /
 * pre-commit drift guard) instead of writing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = join(HERE, '../lib/companion/who-growth-lms.lock.json');
const OUT_PATH = join(HERE, '../lib/companion/who-growth-data.ts');

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const DAYS_PER_MONTH = lock.daysPerMonth;
const MAX_MONTH = lock.maxMonth;

/** Read one entry out of a zip Buffer by exact path, via the central directory. */
function readZipEntry(buf, wantName) {
  // End of central directory record (0x06054b50), scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no EOCD');
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('zip: bad central dir');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (name === wantName) {
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? comp : inflateRawSync(comp);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: entry not found: ${wantName}`);
}

/** Parse an expanded-table sheet into { day: [L, M, S] }. Data cells (cols A–D, rows
 * ≥2) are numeric; column A is the age in days. The header row (1) is skipped. */
function parseSheet(xml) {
  const byDay = {};
  // Global regex; matchAll clones it per row, so lastIndex never carries across rows.
  const cellRe = /<c r="([A-Z]+)(\d+)"[^>]*>(?:<v>([^<]*)<\/v>)?/g;
  for (const row of xml.split('<row')) {
    const cols = {};
    for (const [, col, rowNum, val] of row.matchAll(cellRe)) {
      if (Number(rowNum) >= 2 && val !== undefined && 'ABCD'.includes(col)) cols[col] = val;
    }
    if (cols.A !== undefined && cols.B !== undefined && cols.C !== undefined && cols.D !== undefined) {
      byDay[Number(cols.A)] = [Number(cols.B), Number(cols.C), Number(cols.D)];
    }
  }
  return byDay;
}

/** Round half to EVEN, matching the tables' original transcription. The tie-break
 * only bites at months 24 and 56 (m·30.4375 lands exactly on .5); at month 24 it
 * keeps the recumbent-LENGTH row (day 730) over standing height (day 731), which is
 * the ≤24-month convention this module documents. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const frac = x - f;
  if (frac < 0.5) return f;
  if (frac > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function monthlyRows(byDay) {
  const days = Object.keys(byDay).map(Number);
  const out = [];
  for (let month = 0; month <= MAX_MONTH; month++) {
    let day = roundHalfEven(month * DAYS_PER_MONTH);
    if (byDay[day] === undefined) {
      day = days.reduce((best, d) => (Math.abs(d - day) < Math.abs(best - day) ? d : best), days[0]);
    }
    out.push([month, ...byDay[day]]);
  }
  return out;
}

/** Match Python's `('%.6f' % round(x,6)).rstrip('0').rstrip('.')` numeric formatting. */
function fmt(x) {
  const s = Number(x.toFixed(6)).toString();
  return s === '-0' ? '0' : s;
}

async function fetchVerified(file) {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`fetch ${file.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const md5 = createHash('md5').update(buf).digest('hex');
  if (buf.length !== file.bytes || md5 !== file.md5) {
    throw new Error(
      `checksum mismatch for ${file.measure}/${file.sex}: got ${buf.length}b ${md5}, ` +
        `lock says ${file.bytes}b ${file.md5}`,
    );
  }
  return buf;
}

const HEADER = `/**
 * WHO Child Growth Standards — LMS (Box-Cox) parameters. GENERATED FILE — do not
 * hand-edit; regenerate with scripts/sync-who-growth.mjs (verifies each source md5
 * against who-growth-lms.lock.json). Values are transcribed verbatim from WHO's
 * published day-resolution "expanded tables (z-scores)", never typed from memory.
 *
 * Indicators (birth to 60 completed months, sex-specific):
 *   weight = weight-for-age, height = length/height-for-age, head = head-circumference-for-age.
 *   male = WHO "boys", female = WHO "girls". Source URLs + checksums: who-growth-lms.lock.json.
 *
 * The WHO expanded tables are indexed by age in DAYS. This module downsamples to
 * completed months using WHO Anthro's own average month length of 30.4375 days:
 * month m takes the LMS row at day round(m * 30.4375). This reproduces WHO's
 * published monthly medians to <0.1 unit (verified in who-growth-data.test.ts).
 *
 * Length/height convention: WHO length/height-for-age uses recumbent LENGTH for ages
 * ≤24 months and standing HEIGHT for ≥24 months (a child measures ~0.7 cm shorter
 * standing), and the committed table follows that split. Hale does not capture which
 * position a reading was taken in, so a standing-measured 24-month-old is scored
 * against the length-based row — a ~0.7 cm (≈0.23 z, since 0.7/(M·S) at 24 mo)
 * worst-case downward bias, only at the 24-month boundary and shrinking to zero away
 * from it. Documented, not corrected: it can't cross the |z|=2 band on its own and
 * the provider-deferral caveat covers it.
 *
 * A z-score is z = ((value / M) ** L - 1) / (L * S) for L != 0. L = 1 for
 * length/height and head circumference (a symmetric distribution); L varies for
 * weight. See assessGrowth in growth-standards.ts.
 */

export interface WhoLmsRow {
  /** L — Box-Cox power that normalises the skew. */
  readonly l: number;
  /** M — the median (50th centile) at this age, in the measure's metric unit (kg or cm). */
  readonly m: number;
  /** S — the coefficient of variation. */
  readonly s: number;
}

/** The three growth measures Hale logs, each mapped to a WHO age-based standard. */
export type WhoMeasure = 'weight' | 'height' | 'head';

/** WHO growth standards are sex-specific; this is natal/biological sex, not gender. */
export type WhoSex = 'male' | 'female';

/** Inclusive completed-month range the committed tables cover (WHO 0-5 years). */
export const WHO_MIN_MONTH = 0;
export const WHO_MAX_MONTH = ${MAX_MONTH};
`;

async function main() {
  const tables = {};
  for (const file of lock.files) {
    const buf = await fetchVerified(file);
    const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml').toString('utf8');
    tables[file.measure] ??= {};
    tables[file.measure][file.sex] = monthlyRows(parseSheet(sheet));
    process.stderr.write(`ok ${file.measure}/${file.sex} (${file.bytes}b, md5 verified)\n`);
  }

  let body = '\nexport const WHO_GROWTH_LMS: Record<WhoMeasure, Record<WhoSex, readonly WhoLmsRow[]>> = {\n';
  for (const measure of ['weight', 'height', 'head']) {
    body += `  ${measure}: {\n`;
    for (const sex of ['male', 'female']) {
      body += `    ${sex}: [\n`;
      for (const [month, l, m, s] of tables[measure][sex]) {
        body += `    { l: ${fmt(l)}, m: ${fmt(m)}, s: ${fmt(s)} }, // ${month} mo\n`;
      }
      body += '    ],\n';
    }
    body += '  },\n';
  }
  body += '};\n';

  const content = HEADER + body;
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT_PATH, 'utf8');
    if (current !== content) {
      process.stderr.write('DRIFT: who-growth-data.ts differs from a fresh regen.\n');
      process.exit(1);
    }
    process.stderr.write('who-growth-data.ts is in sync with the WHO source.\n');
    return;
  }
  writeFileSync(OUT_PATH, content);
  process.stderr.write(`wrote ${OUT_PATH}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});
