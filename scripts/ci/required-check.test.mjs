import { describe, expect, it } from 'vitest';
import { REQUIRED_CI_JOB, pickFailedJob } from './classify.mjs';
import { requiredCheckPasses } from './required-check.mjs';

describe('requiredCheckPasses', () => {
  const ok = { changes: 'success', verify: 'success', evals: 'success', workerEvals: 'true' };

  it('passes when workspace checks and worker evals passed', () => {
    expect(requiredCheckPasses(ok)).toMatchObject({ ok: true });
  });

  it('passes a site-only diff when evals were skipped', () => {
    expect(requiredCheckPasses({ ...ok, evals: 'skipped', workerEvals: 'false' })).toMatchObject({
      ok: true,
    });
  });

  it('fails when evals were required and did not succeed', () => {
    expect(requiredCheckPasses({ ...ok, evals: 'failure' }).ok).toBe(false);
    expect(requiredCheckPasses({ ...ok, evals: 'skipped' }).ok).toBe(false);
    expect(requiredCheckPasses({ ...ok, workerEvals: '', evals: 'skipped' }).ok).toBe(false);
  });

  it('fails when the path filter or workspace checks failed', () => {
    expect(requiredCheckPasses({ ...ok, changes: 'failure' }).ok).toBe(false);
    expect(
      requiredCheckPasses({ ...ok, verify: 'failure', evals: 'skipped', workerEvals: 'false' }).ok,
    ).toBe(false);
  });

  it('fails when evals fail even if the filter called the diff site-only', () => {
    expect(requiredCheckPasses({ ...ok, evals: 'failure', workerEvals: 'false' }).ok).toBe(false);
  });
});

describe('pickFailedJob', () => {
  it('classifies the underlying job when the required check also failed', () => {
    const picked = pickFailedJob([
      { name: 'Workspace lint, typecheck, test, build', conclusion: 'success' },
      {
        name: 'Worker evals (cached-only)',
        conclusion: 'failure',
        steps: [{ name: 'Classifier eval (cached-only)', conclusion: 'failure' }],
      },
      {
        name: REQUIRED_CI_JOB,
        conclusion: 'failure',
        steps: [{ name: 'Require', conclusion: 'failure' }],
      },
    ]);
    expect(picked.name).toBe('Worker evals (cached-only)');
  });

  it('keeps the required check when it is the only failure', () => {
    const picked = pickFailedJob([
      { name: REQUIRED_CI_JOB, conclusion: 'failure' },
      { name: 'Path filter', conclusion: 'success' },
    ]);
    expect(picked.name).toBe(REQUIRED_CI_JOB);
  });
});
