import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_ALERT_NOTICE_BROKEN_CLAIMS,
  EMAIL_ALERT_NOTICE_FIXTURES,
} from './email-alert-notice-fixtures.mjs';

const RUNNER = fileURLToPath(new URL('./run-email-alert-notice-eval.mjs', import.meta.url));

/** Spawned without blocking the vitest worker's event loop (general-answer-runner.test.mjs). */
function run(args) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

describe('the email-alert notice eval', () => {
  it('recreates both incident texts and the duplicate Storytime as silent fixtures', () => {
    const silent = EMAIL_ALERT_NOTICE_FIXTURES.filter((f) => f.expect === 'silent').map(
      (f) => f.id,
    );
    expect(silent).toEqual(
      expect.arrayContaining([
        'incident-vendor-unknown-unclear',
        'incident-vendor-unknown-as-event',
        'incident-parent-self-mail-unclear',
        'incident-parent-self-mail-as-event',
        'incident-storytime-matched-unchanged',
      ]),
    );
    const send = EMAIL_ALERT_NOTICE_FIXTURES.filter((f) => f.expect === 'send').map((f) => f.id);
    expect(send).toEqual(
      expect.arrayContaining(['storytime-matched-cancelled', 'storytime-matched-rescheduled']),
    );
  });

  it('--broken: the code-built line fails every silent fixture, with no model call', async () => {
    const { status, out } = await run(['--broken', '--cached-only']);
    expect(out).toContain('FAIL  incident-vendor-unknown-unclear');
    expect(out).toContain('FAIL  incident-parent-self-mail-as-event');
    expect(out).toContain('FAIL  incident-storytime-matched-unchanged');
    expect(out).toContain('broken-mode calibration (every silent fixture must fail): PASS');
    expect(out).toContain('live API calls this run: 0');
    expect(out).toMatch(/CAUGHT {2}broken-claim-slot-free/);
    expect(out).not.toContain('UNRECORDED');
    expect(out).toContain('broken-mode judge calibration (every unsupported claim must fail): PASS');
    expect(out).not.toContain('MISSED');
    expect(status).toBe(0);
  }, 60_000);

  it('the judged replay passes every fixture from committed recordings, with no model call', async () => {
    const { status, out } = await run(['--cached-only']);
    expect(out).toContain('PASS  gym-moved-after-same-openings');
    expect(out).not.toMatch(/^FAIL /m);
    expect(out).toContain('live API calls this run: 0');
    expect(status).toBe(0);
  }, 60_000);

  it('--broken judge calibration: every unsupported claim pairs with a send fixture', () => {
    for (const claim of EMAIL_ALERT_NOTICE_BROKEN_CLAIMS) {
      const fixture = EMAIL_ALERT_NOTICE_FIXTURES.find((f) => f.id === claim.fixtureId);
      expect(fixture?.expect).toBe('send');
    }
  });

  it('--dry: prices every miss without a client', async () => {
    const { status, out } = await run(['--dry']);
    expect(out).toMatch(/worst-case cost of a full live run: \$\d+\.\d{4} USD/);
    expect(out).toContain('broken-claim-slot-free');
    expect(out).toContain('live API calls: 0');
    expect(status).toBe(0);
  }, 60_000);
});
