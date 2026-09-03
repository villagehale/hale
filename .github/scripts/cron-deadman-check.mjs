#!/usr/bin/env node
/**
 * Cron dead-man checker (audit P1-8) — runs INSIDE GitHub Actions, the one
 * failure domain Hale's watchdogs do not share with the Vercel cron substrate
 * they run on. Zero dependencies on purpose: nothing to install, nothing to
 * break.
 *
 * Modes:
 *   node cron-deadman-check.mjs <url>                — fetch and evaluate (the workflow)
 *   node cron-deadman-check.mjs --stdin [httpStatus] — evaluate a body from stdin (tests)
 *
 * Exit 0  = the endpoint answered 200 with ok:true and a non-empty cron list.
 * Exit 1  = ALARM. Any other shape pages: a non-200 status, an unreachable
 *           endpoint, an unparseable body, an EMPTY cron list, or ok:false.
 *           A refusal is not evidence of health — "couldn't check" and "stale"
 *           page identically.
 *
 * On alarm a one-line `summary=` is appended to $GITHUB_OUTPUT (when set) for
 * the workflow's founder SMS. Names and ages only — the endpoint is already
 * unrevealing, and this line ends up in a text message.
 */

import { appendFileSync } from 'node:fs';

const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;
/** Keep the SMS to roughly one segment's worth of stale-cron names. */
const SUMMARY_MAX_CHARS = 220;

/** Pure verdict on one HTTP status + body — the part the parse test drives. */
export function evaluate(httpStatus, rawBody) {
  if (httpStatus !== 200) {
    return { ok: false, summary: `crons health endpoint answered ${httpStatus}` };
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, summary: 'crons health endpoint returned an unparseable body' };
  }
  if (!Array.isArray(body.crons) || body.crons.length === 0) {
    // A page that says nothing must never read as healthy.
    return { ok: false, summary: 'crons health endpoint reported no crons' };
  }
  if (body.ok !== true) {
    const stale = body.crons.filter((cron) => cron.status === 'stale');
    const names = stale
      .map((cron) => `${cron.name} (${formatAge(cron.ageSeconds)})`)
      .join(', ');
    return {
      ok: false,
      summary: truncate(`stale crons: ${names || 'unnamed — endpoint said ok:false'}`),
    };
  }
  return { ok: true, summary: `all ${body.crons.length} crons fresh` };
}

function formatAge(seconds) {
  if (typeof seconds !== 'number') return 'age unknown';
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 60)}m`;
}

function truncate(line) {
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…` : line;
}

async function fetchVerdict(url) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      return evaluate(response.status, await response.text());
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  const kind = lastError instanceof Error ? lastError.name : typeof lastError;
  return { ok: false, summary: `crons health endpoint unreachable (${kind})` };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function emit(result) {
  // One line, no newlines: it is parsed into a GitHub output and an SMS body.
  const summary = result.summary.replaceAll(/\s+/g, ' ').trim();
  console.info(`${result.ok ? 'OK' : 'ALARM'}: ${summary}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

const [, , arg, statusArg] = process.argv;
if (arg === '--stdin') {
  emit(evaluate(Number(statusArg ?? '200'), await readStdin()));
} else if (arg) {
  emit(await fetchVerdict(arg));
} else {
  console.error('usage: cron-deadman-check.mjs <url> | --stdin [httpStatus]');
  process.exitCode = 2;
}
