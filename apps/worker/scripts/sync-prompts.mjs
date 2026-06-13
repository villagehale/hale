#!/usr/bin/env node
// Langfuse <-> disk prompt sync. Langfuse is the authoring/versioning source
// of truth (CLAUDE.md hard rule #2); the runtime loader keeps reading disk.
// This script is the bridge: push/pull move bytes, check guards drift in CI.
//
// Lifecycle: edit in Langfuse -> pull (writes disk + lockfile) -> commit.
// A local edit without a matching pull makes `check` go red.

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const LOCKFILE = join(PROMPTS_DIR, '.langfuse-lock.json');
const PRODUCTION_LABEL = 'production';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function listPromptNames() {
  const topLevel = (await readdir(PROMPTS_DIR))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.slice(0, -'.md'.length));
  // Stage-aware content packs (B17) live one level down in packs/ and are
  // tracked under a `packs/<stage>` name so they are lockfile-guarded too.
  let packs = [];
  try {
    packs = (await readdir(join(PROMPTS_DIR, 'packs')))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => `packs/${f.slice(0, -'.md'.length)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return [...topLevel, ...packs].sort();
}

function readPrompt(name) {
  return readFile(join(PROMPTS_DIR, `${name}.md`), 'utf8');
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

// Live ops require credentials. We never print their values — only which key
// is missing — and we fail before importing the SDK so offline `check` never
// pays the dependency cost.
function requireClient() {
  for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST']) {
    if (!process.env[key]) {
      die(
        `Missing ${key}. Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_HOST in your environment (e.g. apps/worker/.env.local) before running push/pull. \`check\` runs offline and needs none of these.`,
      );
    }
  }
  return import('langfuse').then(({ Langfuse }) => new Langfuse());
}

async function push() {
  const langfuse = await requireClient();
  const names = await listPromptNames();
  for (const name of names) {
    const prompt = await readPrompt(name);
    const created = await langfuse.createPrompt({
      name,
      type: 'text',
      prompt,
      labels: [PRODUCTION_LABEL],
    });
    console.log(`pushed ${name} -> v${created.promptResponse.version} (${PRODUCTION_LABEL})`);
  }
  await langfuse.shutdownAsync();
  console.log(`Pushed ${names.length} prompt(s). Run \`pull\` to refresh the lockfile.`);
}

async function pull() {
  const langfuse = await requireClient();
  const names = await listPromptNames();
  const lock = {};
  for (const name of names) {
    const fetched = await langfuse.getPrompt(name, undefined, { label: PRODUCTION_LABEL });
    const text = fetched.prompt;
    await writeFile(join(PROMPTS_DIR, `${name}.md`), text, 'utf8');
    lock[name] = { name, version: fetched.promptResponse.version, sha256: sha256(text) };
    console.log(`pulled ${name} <- v${fetched.promptResponse.version}`);
  }
  await langfuse.shutdownAsync();
  await writeLockfile(lock);
  console.log(`Pulled ${names.length} prompt(s) and refreshed ${LOCKFILE}.`);
}

async function writeLockfile(lock) {
  await writeFile(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

// Local-first seed: regenerate every lockfile entry from disk, offline.
// Langfuse is still the eventual source of truth (push/pull move bytes once
// keys exist), but before a prompt has ever been pushed there is no version
// to pull — so a brand-new prompt file would otherwise leave `check` red with
// no way forward locally. `seed` records {name, version: null, sha256} from
// disk; version stays null until a real `pull` stamps it. See prompts/README.
async function seed() {
  const names = await listPromptNames();
  const existing = (await readLockfile()) ?? {};
  const lock = {};
  for (const name of names) {
    const sha = sha256(await readPrompt(name));
    lock[name] = { name, version: existing[name]?.version ?? null, sha256: sha };
  }
  await writeLockfile(lock);
  console.log(`Seeded ${names.length} prompt(s) into ${LOCKFILE} from disk.`);
}

async function check() {
  const lock = await readLockfile();
  if (lock === null) {
    die('No prompts/.langfuse-lock.json found. Run `pnpm prompts:pull` to create it from Langfuse.');
  }
  const names = await listPromptNames();
  const offenders = [];
  for (const name of names) {
    const entry = lock[name];
    if (!entry) {
      offenders.push(`${name}: present on disk but absent from lockfile`);
      continue;
    }
    const actual = sha256(await readPrompt(name));
    if (actual !== entry.sha256) {
      offenders.push(`${name}: sha256 ${actual.slice(0, 12)}… != lockfile ${entry.sha256.slice(0, 12)}…`);
    }
  }
  for (const name of Object.keys(lock)) {
    if (!names.includes(name)) offenders.push(`${name}: in lockfile but missing on disk`);
  }
  if (offenders.length > 0) {
    console.error('Prompt drift detected (edit in Langfuse + `pnpm prompts:pull`, do not edit prompts on disk):');
    for (const o of offenders) console.error(`  - ${o}`);
    process.exit(1);
  }
  console.log(`OK: ${names.length} prompt(s) match prompts/.langfuse-lock.json.`);
}

const command = process.argv[2];
const handlers = { push, pull, check, seed };
const handler = handlers[command];
if (!handler) {
  die('Usage: node scripts/sync-prompts.mjs <push|pull|check|seed>');
}
await handler();
