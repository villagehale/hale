#!/usr/bin/env node
// VIL-466 · Post a scripted fake-family conversation to the Preview-only fake inbound
// door (/api/channels/preview/inbound) and read the captured replies back.
//
// Modes (exactly one, same rule as apps/worker/evals/lib/eval-flags.mjs; anything else
// exits 2):  --dry   price the worst case per turn offline, no network at all
//            --live  post the texts (each turn makes real, paid model calls on Preview)
// Options:   --max-usd <n>   hard stop, required. --live refuses to start, and stops
//                            between turns, if the worst case would pass it.
//            --turns <n>     how many of the scripted turns to send (default: all 6)
//            --base-url <u>  the Preview deploy (live only)
// Live goes through `vercel curl <path> --deployment <base-url> -- <curl args>` (a
// logged-in Vercel CLI adds the protection bypass; plain fetch gets 401 on a protected
// Preview). The bearer header is written to a 0600 temp file and passed as `-H @file`,
// so it never lands on a command line or in output.
// The sender is always in the fictional +1 437-555 range. The bearer is read from
// /workspace/secrets/preview-fake-inbound (or PREVIEW_FAKE_INBOUND_SECRET_FILE) and is
// never printed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = ['--dry', '--live'];

// List USD per 1M tokens, same card as apps/worker/evals/lib/harness.mjs PRICE.
const PRICE = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-opus-5-5': { input: 15.0, output: 75.0 },
};

// One inbound turn's worst case, from the model limits in code and the largest prompt
// any ledger has recorded for that call (/workspace/spend/*.json, 910-coach-final.json):
//  - coach loop: apps/web/lib/channel/coach/runtime.ts MAX_STEPS=6, MAX_TOKENS=400,
//    converse lane = Sonnet 5.5; largest recorded prompt 23,311 tokens, padded to 32k
//    per step (tool results grow it) and priced uncached;
//  - reply compose: reply-copy/compose.ts maxSteps 1, MAX_TOKENS 320, priced as Sonnet;
//  - intake/extract on a new family: Sonnet, largest recorded 2,453 in, 1,024 out;
//  - a triage/screen call: priced at Sonnet, 4k in, 1,024 out.
export const TURN_CALLS = [
  ...Array.from({ length: 6 }, (_, i) => ({
    tag: `coach-step-${i + 1}`,
    model: 'claude-sonnet-5-5',
    inTokens: 32000,
    maxOut: 400,
  })),
  { tag: 'reply-compose', model: 'claude-sonnet-5-5', inTokens: 8000, maxOut: 320 },
  { tag: 'intake-extract', model: 'claude-sonnet-5-5', inTokens: 4000, maxOut: 1024 },
  { tag: 'triage', model: 'claude-sonnet-5-5', inTokens: 4000, maxOut: 1024 },
];

export const SCRIPT = [
  'Hi! A friend said you help find stuff for kids. I have two, Maya 7 and Leo 4, we live near Danforth and Pape, postal code M4K 1N1.',
  'Maya loves swimming and Leo is into anything with trucks lol',
  'Is there anything on this Saturday morning for both of them?',
  'What should we bring and is there parking?',
  'Actually Saturday got busy, what about Sunday afternoon?',
  'Perfect, thanks. Can you remind me the day before?',
];

export const FAKE_FROM = '+14375550188';

export function callUsd({ model, inTokens, maxOut }) {
  const p = PRICE[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * p.input + (maxOut / 1e6) * p.output;
}

export const turnWorstUsd = () => TURN_CALLS.reduce((s, c) => s + callUsd(c), 0);

export function parseArgs(argv) {
  const modes = argv.filter(
    (a) => a.startsWith('--') && !['--max-usd', '--turns', '--base-url'].includes(a),
  );
  const unknown = modes.filter((a) => !MODES.includes(a));
  if (unknown.length)
    throw new Error(`unknown flag(s): ${unknown.join(' ')}. Allowed modes: ${MODES.join(' ')}`);
  if (modes.length !== 1) throw new Error(`pass exactly one mode: ${MODES.join(' | ')}`);
  const opt = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const maxUsd = Number(opt('--max-usd'));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    throw new Error('--max-usd <positive number> is required');
  const turns = opt('--turns') === undefined ? SCRIPT.length : Number(opt('--turns'));
  if (!Number.isInteger(turns) || turns < 1 || turns > SCRIPT.length)
    throw new Error(`--turns must be 1..${SCRIPT.length}`);
  return { mode: modes[0].slice(2), maxUsd, turns, baseUrl: opt('--base-url') };
}

function dry({ maxUsd, turns }) {
  const per = turnWorstUsd();
  console.log(`preview-fake-family --dry: no network, ${turns} turn(s) from ${FAKE_FROM}`);
  for (const c of TURN_CALLS)
    console.log(
      `  ${c.tag.padEnd(16)} ${c.model} in ${c.inTokens} out ${c.maxOut}  $${callUsd(c).toFixed(4)}`,
    );
  console.log(`  worst case per turn: $${per.toFixed(4)}`);
  console.log(`  worst case total:    $${(per * turns).toFixed(4)} (cap $${maxUsd})`);
  if (per * turns > maxUsd)
    console.log(`  --live would stop after ${Math.floor(maxUsd / per)} turn(s) under this cap`);
}

async function live({ maxUsd, turns, baseUrl }) {
  if (!baseUrl?.startsWith('https://'))
    throw new Error('--live needs --base-url https://<preview deploy>');
  const per = turnWorstUsd();
  const secret = readFileSync(
    process.env.PREVIEW_FAKE_INBOUND_SECRET_FILE ?? '/workspace/secrets/preview-fake-inbound',
    'utf8',
  ).trim();
  const dir = mkdtempSync(join(tmpdir(), 'pff-'));
  const hdr = join(dir, 'h');
  writeFileSync(hdr, `authorization: Bearer ${secret}\ncontent-type: application/json\n`, {
    mode: 0o600,
  });
  const vcurl = (path, extra = []) => {
    try {
      return execFileSync(
        'vercel',
        [
          'curl',
          path,
          '--deployment',
          baseUrl,
          '--',
          '-sS',
          '-H',
          `@${hdr}`,
          '-w',
          '\n%{http_code}',
          ...extra,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 26 },
      )
        .split(secret)
        .join('<redacted>');
    } catch (err) {
      return `vercel curl failed: ${String(err.stderr ?? err.message)
        .split(secret)
        .join('<redacted>')}\n000`;
    }
  };
  const split = (out) => {
    const i = out.lastIndexOf('\n');
    return { body: out.slice(0, i), status: Number(out.slice(i + 1)) };
  };
  try {
    let reserved = 0;
    for (let i = 0; i < turns; i++) {
      if (reserved + per > maxUsd) {
        console.log(
          `stop: turn ${i + 1} worst case would pass --max-usd ${maxUsd} (reserved $${reserved.toFixed(4)})`,
        );
        break;
      }
      reserved += per;
      const { body, status } = split(
        vcurl('/api/channels/preview/inbound', [
          '-X',
          'POST',
          '-d',
          JSON.stringify({ from: FAKE_FROM, text: SCRIPT[i] }),
        ]),
      );
      console.log(`turn ${i + 1}: ${status} ${body}`);
      if (status < 200 || status >= 300) break;
      await new Promise((r) => setTimeout(r, 20000));
    }
    const { body } = split(
      vcurl(`/api/channels/preview/captured?to=${encodeURIComponent(FAKE_FROM)}`),
    );
    console.log(body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`preview-fake-family: ${err.message}`);
    process.exit(2);
  }
  if (args.mode === 'dry') return dry(args);
  return live(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
