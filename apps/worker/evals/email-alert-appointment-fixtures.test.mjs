import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMAIL_ALERT_APPOINTMENT_FIXTURES } from './email-alert-appointment-fixtures.mjs';

const RUNNER = fileURLToPath(new URL('./run-email-alert-appointment-eval.mjs', import.meta.url));

function run(args) {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_API_KEY_TEST: _test, ...env } = process.env;
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

describe('the appointment eval fixtures', () => {
  it('covers the duplicate, the clash, and a visit that is neither', () => {
    expect(EMAIL_ALERT_APPOINTMENT_FIXTURES.map((fixture) => [fixture.id, fixture.expect])).toEqual(
      [
        ['rami-reminder-same-appointment', 'same'],
        ['cookie-cutters-clash', 'clash'],
        ['thursday-swim-no-clash', 'send'],
      ],
    );
  });

  it('--dry prices nothing and does not open a client', async () => {
    const { status, out } = await run(['--dry']);
    expect(out).toContain('fixtures=3');
    expect(out).toContain('no client');
    expect(status).toBe(0);
  });
});
