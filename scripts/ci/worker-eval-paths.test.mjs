import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CI_JOB } from './classify.mjs';
import {
  isSiteTreePath,
  lockfileAffectsWorkerEvals,
  packageKeyReferenced,
  parseLockfile,
  pathsFromNameStatus,
  splitPackageKey,
  workerEvalsRequired,
} from './worker-eval-paths.mjs';

const LOCKFILE_BEFORE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  react: 19.2.3

importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2.3.3
        version: 2.9.15

  apps/site:
    dependencies:
      uqr:
        specifier: ^0.1.2
        version: 0.1.3

  apps/worker:
    dependencies:
      zod:
        specifier: ^3.24.1
        version: 3.25.76

packages:

  turbo@2.9.15:
    resolution: {integrity: sha512-root}

  uqr@0.1.3:
    resolution: {integrity: sha512-site}

  zod@3.25.76:
    resolution: {integrity: sha512-worker}
`;

function withSiteUqr(version, integrity = 'sha512-site') {
  return LOCKFILE_BEFORE.replaceAll('0.1.3', version).replace('sha512-site', integrity);
}

describe('isSiteTreePath', () => {
  it('matches the site tree only', () => {
    expect(isSiteTreePath('apps/site/app/page.tsx')).toBe(true);
    expect(isSiteTreePath('apps/site/package.json')).toBe(true);
    expect(isSiteTreePath('apps/sitemap.ts')).toBe(false);
    expect(isSiteTreePath('apps/web/app/page.tsx')).toBe(false);
    expect(isSiteTreePath('packages/types/src/index.ts')).toBe(false);
  });
});

describe('pathsFromNameStatus', () => {
  it('counts both sides of a rename', () => {
    expect(pathsFromNameStatus(['R100\tapps/worker/old.ts\tapps/site/new.ts'])).toEqual([
      'apps/worker/old.ts',
      'apps/site/new.ts',
    ]);
  });
});

describe('workerEvalsRequired', () => {
  it('skips evals for a site-only diff', () => {
    expect(workerEvalsRequired(['apps/site/app/page.tsx', 'apps/site/package.json'])).toBe(false);
  });

  it('keeps evals when web, worker, agent, or a shared package changes', () => {
    expect(workerEvalsRequired(['apps/web/app/page.tsx'])).toBe(true);
    expect(workerEvalsRequired(['apps/worker/src/index.ts'])).toBe(true);
    expect(workerEvalsRequired(['packages/agent/src/skill.ts'])).toBe(true);
    expect(workerEvalsRequired(['packages/types/src/index.ts'])).toBe(true);
    expect(workerEvalsRequired(['packages/db/src/schema.ts'])).toBe(true);
    expect(workerEvalsRequired(['packages/tools-contracts/src/index.ts'])).toBe(true);
  });

  it('keeps evals for an unknown path mixed with site files', () => {
    expect(workerEvalsRequired(['apps/site/app/page.tsx', 'README.md'])).toBe(true);
    expect(workerEvalsRequired(['.github/workflows/ci.yml'])).toBe(true);
  });

  it('keeps evals when the diff is empty or missing', () => {
    expect(workerEvalsRequired([])).toBe(true);
    expect(workerEvalsRequired(null)).toBe(true);
  });

  it('keeps evals when a site rename still touches worker', () => {
    const files = pathsFromNameStatus(['R100\tapps/worker/old.ts\tapps/site/new.ts']);
    expect(workerEvalsRequired(files)).toBe(true);
  });

  it('skips evals when the lockfile change is a site-only dependency', () => {
    const after = withSiteUqr('0.1.4');
    expect(workerEvalsRequired(['pnpm-lock.yaml'], LOCKFILE_BEFORE, after)).toBe(false);
    expect(
      workerEvalsRequired(['apps/site/package.json', 'pnpm-lock.yaml'], LOCKFILE_BEFORE, after),
    ).toBe(false);
  });

  it('keeps evals when the lockfile changes a non-site importer, overrides, or a shared package', () => {
    const workerBump = LOCKFILE_BEFORE.replace('version: 3.25.76', 'version: 3.25.77');
    expect(workerEvalsRequired(['pnpm-lock.yaml'], LOCKFILE_BEFORE, workerBump)).toBe(true);

    const overrideBump = LOCKFILE_BEFORE.replace('react: 19.2.3', 'react: 19.2.4');
    expect(workerEvalsRequired(['pnpm-lock.yaml'], LOCKFILE_BEFORE, overrideBump)).toBe(true);

    const zodIntegrity = LOCKFILE_BEFORE.replace('sha512-worker', 'sha512-changed');
    expect(workerEvalsRequired(['pnpm-lock.yaml'], LOCKFILE_BEFORE, zodIntegrity)).toBe(true);
  });

  it('skips evals when only a site package entry in the catalog changes', () => {
    const integrity = LOCKFILE_BEFORE.replace('sha512-site', 'sha512-site-2');
    expect(lockfileAffectsWorkerEvals(LOCKFILE_BEFORE, integrity)).toBe(false);
  });

  it('keeps evals when the lockfile text is missing', () => {
    expect(workerEvalsRequired(['pnpm-lock.yaml'], '', '')).toBe(true);
  });
});

describe('the committed pnpm-lock.yaml', () => {
  const text = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');

  it('parses every importer and ignores an unchanged lockfile', () => {
    const parsed = parseLockfile(text);
    expect(Object.keys(parsed.importers)).toEqual([
      '.',
      'apps/site',
      'apps/web',
      'apps/worker',
      'packages/agent',
      'packages/db',
      'packages/tools-contracts',
      'packages/types',
    ]);
    expect(Object.keys(parsed.snapshots).length).toBeGreaterThan(100);
    expect(lockfileAffectsWorkerEvals(text, text)).toBe(false);
  });

  it('skips a site-only snapshot edit and keeps a shared package edit', () => {
    const site = text.replace('  uqr@0.1.3: {}', '  uqr@0.1.3:\n    optional: true');
    expect(site).not.toBe(text);
    expect(lockfileAffectsWorkerEvals(text, site)).toBe(false);

    const shared = text.replace('  zod@3.25.76: {}', '  zod@3.25.76:\n    optional: true');
    expect(shared).not.toBe(text);
    expect(lockfileAffectsWorkerEvals(text, shared)).toBe(true);
  });
});

describe('package keys', () => {
  it('splits scoped names before the peer suffix', () => {
    expect(splitPackageKey("'@vercel/speed-insights@2.0.0(next@15.5.18)'".slice(1, -1))).toEqual({
      name: '@vercel/speed-insights',
      version: '2.0.0',
    });
    expect(splitPackageKey('vitest@3.2.6(@types/debug@4.1.13)')).toEqual({
      name: 'vitest',
      version: '3.2.6',
    });
  });

  it('matches a direct importer selection and a peer mention', () => {
    const worker = `
      zod:
        specifier: ^3.24.1
        version: 3.25.76
      drizzle-orm:
        version: 0.38.4(react@19.2.3)
    `;
    expect(packageKeyReferenced('zod@3.25.76', worker)).toBe(true);
    expect(packageKeyReferenced('react@19.2.3', worker)).toBe(true);
    expect(packageKeyReferenced('uqr@0.1.3', worker)).toBe(false);
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobNames = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]);

  function jobBlock(id) {
    const header = `\n  ${id}:\n`;
    const start = ci.indexOf(header);
    expect(start, id).toBeGreaterThan(-1);
    const rest = ci.slice(start + header.length);
    const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('does not path-filter the workflow trigger', () => {
    const onBlock = ci.slice(0, ci.indexOf('\njobs:\n'));
    expect(onBlock).not.toMatch(/^\s+paths:/m);
  });

  it('keeps the required check name on exactly one job', () => {
    expect(jobNames.filter((name) => name === REQUIRED_CI_JOB)).toEqual([REQUIRED_CI_JOB]);
    expect(jobBlock('required')).toContain(`name: ${REQUIRED_CI_JOB}`);
    expect(jobBlock('required')).toContain('node scripts/ci/required-check.mjs');
  });

  it('runs workspace lint, typecheck, test, and build on every diff', () => {
    const verify = jobBlock('verify');
    expect(verify).toContain('pnpm lint');
    expect(verify).toContain('pnpm typecheck');
    expect(verify).toContain('pnpm test');
    expect(verify).toContain('pnpm test:scripts');
    expect(verify).toContain('pnpm build');
    expect(verify).toContain('prompts:check');
    expect(verify).toContain('skills:check');
    expect(verify).not.toContain('eval:');
  });

  it('runs each cached-only worker eval only from the filtered job', () => {
    const evals = jobBlock('worker-evals');
    expect(evals).toContain("needs.changes.outputs.worker_evals == 'true'");
    const commands = [
      'eval:classifier',
      'eval:drafter',
      'eval:memory',
      'eval:memory-writeback',
      'eval:reviewer',
      'eval:week-summary',
      'eval:agents',
      'eval:village-search',
      'eval:sentinel',
      'eval:intake',
      'eval:intake-voice',
      'eval:intake-answer',
      'eval:inbound-lane',
      'eval:general-answer',
      'eval:medical-symptom',
      'eval:turn-apology',
      'eval:followup-voice',
      'eval:calendar-voice',
      'eval:identity-ask',
      'eval:reminder-voice',
      'eval:intro-voice',
      'eval:reply-resolver',
      'eval:radar',
      'eval:nudge',
      'eval:rsvp',
      'eval:coach-channel',
      'eval:voice-turn',
      'eval:coach-plan',
      'eval:civic-hours',
      'eval:registration-verify',
      'eval:activity-verdict',
      'eval:activity-finder',
      'eval:activity-deep',
      'eval:travel-extract',
    ];
    for (const command of commands) {
      expect(evals, command).toContain(command);
      expect(jobBlock('verify'), command).not.toContain(command);
    }
  });
});
