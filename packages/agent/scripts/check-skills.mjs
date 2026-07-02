#!/usr/bin/env node
// Drift-check for the web-side skill prompts (CLAUDE.md hard rule #2).
//
// The LIVE web pipeline (/api/events/ingest, /api/coach) loads its agent system
// prompts from packages/agent/skills/*.md via loadSkill and feeds them straight
// to Anthropic as `system=`. The worker's Langfuse drift-check only guards
// apps/worker/prompts/* — it never sees these files. Without this gate a silent
// on-disk edit to any skill (classify-event, draft-action, review-action,
// ask-hale, …) would ship to prod with no CI failure.
//
// `seed` records {file, sha256} for every skill into .skills-lock.json.
// `check` recomputes and exits non-zero on any mismatch/missing/extra file.

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const LOCKFILE = join(SKILLS_DIR, '.skills-lock.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listSkillFiles() {
  return (await readdir(SKILLS_DIR))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
}

function readSkillBytes(file) {
  return readFile(join(SKILLS_DIR, file));
}

async function readLockfile() {
  try {
    return JSON.parse(await readFile(LOCKFILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function die(message) {
  console.error(message);
  process.exit(1);
}

async function writeLockfile(lock) {
  await writeFile(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function seed() {
  const files = await listSkillFiles();
  const lock = {};
  for (const file of files) {
    lock[file] = { file, sha256: sha256(await readSkillBytes(file)) };
  }
  await writeLockfile(lock);
  console.log(`Seeded ${files.length} skill(s) into ${LOCKFILE} from disk.`);
}

async function check() {
  const lock = await readLockfile();
  if (lock === null) {
    die('No skills/.skills-lock.json found. Run `pnpm skills:seed` to create it from disk.');
  }
  const files = await listSkillFiles();
  const offenders = [];
  for (const file of files) {
    const entry = lock[file];
    if (!entry) {
      offenders.push(`${file}: present on disk but absent from lockfile`);
      continue;
    }
    const actual = sha256(await readSkillBytes(file));
    if (actual !== entry.sha256) {
      offenders.push(`${file}: sha256 ${actual.slice(0, 12)}… != lockfile ${entry.sha256.slice(0, 12)}…`);
    }
  }
  for (const file of Object.keys(lock)) {
    if (!files.includes(file)) offenders.push(`${file}: in lockfile but missing on disk`);
  }
  if (offenders.length > 0) {
    console.error('Skill prompt drift detected (edit deliberately, then `pnpm --filter @hale/agent skills:seed` and commit the lockfile):');
    for (const o of offenders) console.error(`  - ${o}`);
    process.exit(1);
  }
  console.log(`OK: ${files.length} skill(s) match skills/.skills-lock.json.`);
}

const command = process.argv[2];
const handlers = { check, seed };
const handler = handlers[command];
if (!handler) {
  die('Usage: node scripts/check-skills.mjs <check|seed>');
}
await handler();
