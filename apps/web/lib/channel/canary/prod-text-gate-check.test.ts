import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The checker GitHub actually runs, and the workflow around it.
 *
 * A broken candidate exits 1 and the workflow never promotes. A candidate that
 * answered exits 0, which is the commit status Vercel aliases on. The script
 * is spawned, not reimplemented.
 */

const CHECKER = fileURLToPath(
  new URL('../../../../../.github/scripts/prod-text-gate.mjs', import.meta.url),
);
const WORKFLOW = fileURLToPath(
  new URL('../../../../../.github/workflows/prod-text-gate.yml', import.meta.url),
);
const WEB_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function runChecker(
  httpStatus: number,
  body: string,
  env: Record<string, string | undefined> = {},
): { exitCode: number; output: string; githubOutput: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prod-text-gate-'));
  const outputPath = join(dir, 'github-output');
  try {
    const output = execFileSync(process.execPath, [CHECKER, '--stdin', String(httpStatus)], {
      input: body,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GIT_SHA: 'abc123def4567890',
        DEPLOYMENT_URL: 'https://hale-web-candidate.vercel.app',
        RUN_URL: 'https://github.com/villagehale/hale/actions/runs/1',
        CRON_SECRET: 'super-secret-canary',
        ...env,
      },
    });
    return { exitCode: 0, output, githubOutput: readFileSync(outputPath, 'utf8') };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string; stderr: string };
    let githubOutput = '';
    try {
      githubOutput = readFileSync(outputPath, 'utf8');
    } catch {
      githubOutput = '';
    }
    return {
      exitCode: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      githubOutput,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('prod text gate checker', () => {
  it('a candidate that answered exits 0', () => {
    const pass = runChecker(200, JSON.stringify({ ok: true, stage: 'answered', attempts: 1 }));
    expect(pass.exitCode).toBe(0);
    expect(pass.output).toContain('answered on the candidate deployment');
    expect(pass.output).not.toContain('super-secret-canary');
  });

  it('a broken candidate is held: never answered, refused, or a preview skip', () => {
    const broken = runChecker(
      200,
      JSON.stringify({ ok: false, stage: 'never_answered', attempts: 1 }),
    );
    expect(broken.exitCode).toBe(1);
    expect(broken.output).toContain('stage never_answered');
    expect(broken.githubOutput).toContain('Prod text gate held abc123def456');
    expect(broken.githubOutput).toContain('previous deployment');
    expect(broken.githubOutput).not.toContain('super-secret-canary');
    expect(broken.githubOutput).not.toContain('+1');

    expect(runChecker(401, 'nope').exitCode).toBe(1);
    expect(
      runChecker(200, JSON.stringify({ ok: true, skipped: 'preview_cron_not_scoped' })).exitCode,
    ).toBe(1);
  });

  it('refuses the parent domain and a missing cron secret before any fetch', () => {
    const live = execFileSyncFail({ DEPLOYMENT_URL: 'https://app.villagehale.com' });
    expect(live.exitCode).toBe(1);
    expect(live.output).toContain('not a candidate deployment host');
    expect(live.output).not.toContain('super-secret-canary');

    const missing = execFileSyncFail({
      CRON_SECRET: '',
      DEPLOYMENT_URL: 'https://hale-web-x.vercel.app',
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('CRON_SECRET');
  });
});

function execFileSyncFail(env: Record<string, string | undefined>): {
  exitCode: number;
  output: string;
} {
  try {
    const output = execFileSync(process.execPath, [CHECKER], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CRON_SECRET: 'super-secret-canary',
        ...env,
      },
    });
    return { exitCode: 0, output };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string; stderr: string };
    return {
      exitCode: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('the workflow holds production instead of promoting', () => {
  it('reports one Vercel status, pages #ops, and opens a fix task', () => {
    const yml = readFileSync(WORKFLOW, 'utf8');
    expect(yml).toContain("name: 'Vercel - hale-web: prod-text-gate (production)'");
    expect(yml).toContain('vercel.deployment.ready');
    expect(yml).toContain('OPS_SLACK_WEBHOOK_URL');
    expect(yml).toContain('C0C5XMCAQ56');
    expect(yml).toContain('gh issue create');
    expect(yml).toContain('did_not_finish');
    expect(yml).toContain('Re-run the failed jobs on this run');
    expect(yml).not.toContain('steps.gate.outputs.title !=');
    expect(yml).not.toContain('workflow_dispatch');
    expect(yml).toContain('CRON_SECRET');
    expect(yml).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(yml).not.toContain('vercel promote');
    expect(yml).not.toContain('vercel rollback');
    expect(yml).not.toContain('FOUNDER_ALERT_PHONE');
    expect(yml).not.toContain('api.twilio.com');
    expect(yml).not.toContain('app.villagehale.com');
  });

  it('the gate route is not a scheduled cron, and the linq door kicks its own URL', () => {
    const vercel = readFileSync(`${WEB_ROOT}vercel.json`, 'utf8');
    expect(vercel).not.toContain('prod-text-gate');
    const route = readFileSync(`${WEB_ROOT}app/api/cron/prod-text-gate/route.ts`, 'utf8');
    expect(route).toContain("cronRoute('prod-text-gate'");
    const inbound = readFileSync(`${WEB_ROOT}app/api/channels/linq/inbound/route.ts`, 'utf8');
    expect(inbound).toContain('inboundDrainOrigin');
    const script = readFileSync(CHECKER, 'utf8');
    expect(script).toContain('could not read the candidate response');
  });
});
