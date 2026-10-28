import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUP_PLAN_CALENDAR_REPORT_FIXTURES } from './group-plan-calendar-report-fixtures.mjs';
import { CACHE_DIR } from './lib/harness.mjs';

/**
 * The group plan report's runner (VIL-443), run as a process with no API key. Its corpus
 * is not recorded until a price is agreed, so what runs here is what runs before that:
 * the calibration, whose gate is the exit code, and the price, which calls no model and
 * writes no recording.
 */
const RUNNER = fileURLToPath(new URL('./group-plan-calendar-report-eval.mjs', import.meta.url));
const FIXTURES_URL = new URL('./group-plan-calendar-report-fixtures.mjs', import.meta.url).href;

/** Waits on the child without blocking the vitest worker's event loop. Nothing it could
 * spend with is passed on: no key, no cap, no ledger, no Gateway. */
function runRunner(args, preloads = []) {
  const {
    ANTHROPIC_API_KEY: _key,
    HALE_MAX_USD: _cap,
    HALE_SPEND_LEDGER: _ledger,
    EVAL_GATEWAY_MODEL: _gateway,
    ...env
  } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...preloads.flatMap((preload) => ['--import', preload]), RUNNER, ...args],
      { env },
    );
    let report = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      report += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      report += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, report }));
  });
}

const graded = (report) =>
  [...report.matchAll(/^(PASS|FAIL) {2}(\S+)/gm)].map(([, tag, id]) => [id, tag]);

describe('the group plan report runner', { timeout: 60_000 }, () => {
  it('fails the broken stand-in on every fixture, without a model call', async () => {
    const run = await runRunner(['--broken']);

    expect(graded(run.report)).toEqual(
      GROUP_PLAN_CALENDAR_REPORT_FIXTURES.map((fixture) => [fixture.id, 'FAIL']),
    );
    expect(run.report).toContain('live API calls this run: 0');
    expect(run.report).toContain(
      'broken-mode calibration (must fail every fixture): PASS (exit 0)',
    );
    expect(run.status).toBe(0);
  });

  it('exits 1 when the stand-in gets through on any fixture', async () => {
    const passesOnTheCancel = `data:text/javascript,${encodeURIComponent(
      `import { GROUP_PLAN_CALENDAR_REPORT_BROKEN } from ${JSON.stringify(FIXTURES_URL)};
       GROUP_PLAN_CALENDAR_REPORT_BROKEN.messages = ['La clase de natación del sábado ya no va.'];`,
    )}`;
    const run = await runRunner(['--broken'], [passesOnTheCancel]);

    // Positive control: it is the cancel, the one fixture with no link to carry, that let
    // it through, and every other fixture still failed it.
    expect(graded(run.report)).toEqual(
      GROUP_PLAN_CALENDAR_REPORT_FIXTURES.map((fixture) => [
        fixture.id,
        fixture.id === 'es-cancelled' ? 'PASS' : 'FAIL',
      ]),
    );
    expect(run.report).toContain(
      'broken-mode calibration (must fail every fixture): FAIL (exit 1)',
    );
    expect(run.status).toBe(1);
  });

  it('prices one recording without calling a model or writing a recording', async () => {
    const recordings = readdirSync(CACHE_DIR).length;
    const run = await runRunner(['--dry']);
    const fixtures = GROUP_PLAN_CALENDAR_REPORT_FIXTURES.length;

    expect(run.report).toMatch(
      new RegExp(
        `^worst case for one recording: ${fixtures} fixtures x \\(2 drafts \\+ 1 verdict\\) x 2 calls = ${fixtures * 6} calls, \\d+ in \\+ \\d+ out tokens at list price = \\$\\d+\\.\\d{4} USD$`,
        'm',
      ),
    );
    expect(run.report).toMatch(
      /^one group text in production \(no judge\), worst fixture: 4 calls = \$\d+\.\d{4} USD$/m,
    );
    expect(run.report).toContain('live API calls this run: 0 | nothing written');
    expect(readdirSync(CACHE_DIR)).toHaveLength(recordings);
    expect(run.status).toBe(0);
  });

  it('refuses a live run with no spend cap before it calls anything', async () => {
    const recordings = readdirSync(CACHE_DIR).length;
    const run = await runRunner([]);

    expect(run.report).toContain('spend-cap: a live model call needs BOTH a cap');
    expect(run.report).not.toMatch(/^(PASS|FAIL) {2}/m);
    expect(readdirSync(CACHE_DIR)).toHaveLength(recordings);
    expect(run.status).toBe(2);
  });
});
