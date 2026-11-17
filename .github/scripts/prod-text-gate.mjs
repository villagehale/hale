#!/usr/bin/env node
/**
 * Production text gate (VIL-696). Runs in GitHub Actions, off the deployment
 * it is judging.
 *
 *   node prod-text-gate.mjs
 *     GET $DEPLOYMENT_URL/api/cron/prod-text-gate and exit with its verdict.
 *   node prod-text-gate.mjs --stdin <httpStatus>
 *     Judge a body on stdin. The test path. No network.
 *
 * Exit 0 only when the candidate deployment answered the probe itself.
 * Anything else — a refusal, a redirect, an unparseable body, a skipped
 * preview cron — exits 1. A pass is the commit status Vercel waits on before
 * it aliases production. This script never promotes and never rolls back.
 *
 * Names only. The secret values are headers, never logs, never the issue body.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FETCH_TIMEOUT_MS = 280_000;

/** Hosts that already serve parents. A pass against one of these would alias
 * a build this script never called. */
const LIVE_HOSTS = new Set(['app.villagehale.com', 'villagehale.com', 'www.villagehale.com']);

/**
 * The candidate's origin, or a refusal. https, not a live parent domain, and
 * a Vercel deployment host — the URL `vercel.deployment.ready` carries.
 */
export function candidateOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, summary: 'DEPLOYMENT_URL is missing or not a URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, summary: 'DEPLOYMENT_URL is not https' };
  }
  if (LIVE_HOSTS.has(url.hostname) || !url.hostname.endsWith('.vercel.app')) {
    return {
      ok: false,
      summary: 'DEPLOYMENT_URL is not a candidate deployment host',
    };
  }
  return { ok: true, origin: url.origin };
}

/** Pure verdict on one HTTP status + body. */
export function evaluate(httpStatus, rawBody) {
  if (httpStatus < 200 || httpStatus >= 300) {
    return hold(`prod text gate answered ${httpStatus}`, 'unreachable');
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return hold('prod text gate returned an unparseable body', 'unparseable');
  }
  if (body && body.ok === true && body.stage === 'answered') {
    return {
      ok: true,
      stage: 'answered',
      summary: 'prod text gate answered on the candidate deployment',
      title: '',
      body: '',
    };
  }
  const stage = body && typeof body.stage === 'string' && body.stage ? body.stage : 'unexpected';
  return hold(`prod text gate held production. stage ${stage}.`, stage);
}

function hold(summary, stage) {
  return { ok: false, stage, summary, title: '', body: '' };
}

/** One GitHub issue. The title is the commit, so a re-run finds the open one. */
export function fixTask({ stage, deploymentUrl, sha, runUrl }) {
  const short = String(sha || 'unknown').slice(0, 12);
  const title = `Prod text gate held ${short}`;
  const lines = [
    'The production text gate did not get a reply from the candidate build, so the production domains stay on the previous deployment.',
    '',
    `- Stage: \`${stage}\``,
    `- Commit: \`${sha || 'unknown'}\``,
    `- Deployment: ${deploymentUrl || 'unknown'}`,
    `- Run: ${runUrl || 'unknown'}`,
    '',
    'The probe is the synthetic canary line. It does not text a parent. No eval suite ran.',
    '',
    'Vercel aliases the production domains only after the commit status `Vercel - hale-web: prod-text-gate (production)` succeeds. This run did not succeed.',
  ];
  return { title, body: lines.join('\n') };
}

function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const marker = `gate_${name}_${process.pid}`;
  appendFileSync(file, `${name}<<${marker}\n${value}\n${marker}\n`);
}

function finish(verdict, task) {
  const title = task?.title ?? '';
  const body = task?.body ?? '';
  writeOutput('stage', verdict.stage);
  writeOutput('summary', verdict.summary);
  writeOutput('title', title);
  writeOutput('body', body);
  if (!verdict.ok) {
    console.error(`ALARM ${verdict.summary}`);
    process.exitCode = 1;
    return;
  }
  console.info(verdict.summary);
}

function taskFor(verdict) {
  if (verdict.ok) return null;
  return fixTask({
    stage: verdict.stage,
    deploymentUrl: process.env.DEPLOYMENT_URL ?? '',
    sha: process.env.GIT_SHA ?? '',
    runUrl: process.env.RUN_URL ?? '',
  });
}

async function main() {
  if (process.argv[2] === '--stdin') {
    const status = Number(process.argv[3]);
    const raw = readFileSync(0, 'utf8');
    const verdict = evaluate(Number.isFinite(status) ? status : 0, raw);
    finish(verdict, taskFor(verdict));
    return;
  }

  const candidate = candidateOrigin(process.env.DEPLOYMENT_URL);
  if (!candidate.ok) {
    const verdict = hold(candidate.summary, 'not_configured');
    finish(verdict, taskFor(verdict));
    return;
  }
  if (!process.env.CRON_SECRET) {
    const verdict = hold(
      'prod text gate cannot run — missing Actions secret CRON_SECRET',
      'not_configured',
    );
    finish(verdict, taskFor(verdict));
    return;
  }

  const headers = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  if (process.env.VERCEL_OIDC_TOKEN) {
    headers['x-vercel-trusted-oidc-idp-token'] = process.env.VERCEL_OIDC_TOKEN;
  }

  let response;
  try {
    response = await fetch(`${candidate.origin}/api/cron/prod-text-gate`, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    const summary = 'prod text gate could not reach the candidate deployment';
    finish(hold(summary, 'unreachable'), taskFor(hold(summary, 'unreachable')));
    return;
  }

  const raw = await response.text();
  const verdict = evaluate(response.status, raw);
  finish(verdict, taskFor(verdict));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
