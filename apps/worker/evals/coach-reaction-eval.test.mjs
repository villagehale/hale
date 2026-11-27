import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-coach-reaction-eval.mjs');

function run(flags, extraEnv = {}) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const child = { ...env, ...extraEnv };
  // Recorded requests keep tools in skill order. The layout flag reorders
  // them, so a cached-only replay drops it here. The runner does not read
  // the flag itself. A live run (no --cached-only) keeps the caller's value.
  if (flags.includes('--cached-only')) child.PROMPT_CACHE_LAYOUT_ENABLED = undefined;
  return spawnSync(process.execPath, [RUNNER, ...flags], {
    env: child,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('VIL-680 coach-reaction eval calibration never spends', () => {
  it('--broken: a thumbs-up as the whole answer fails the objective metric', () => {
    const out = run(['--cached-only', '--broken']);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('expected the words to go');
    expect(out.stdout).toContain('live API calls this run: 0');
  }, 120_000);

  // A turn whose tools ran keeps its words in code (tools_ran), so only a case whose recorded
  // turn ran none measures the model. thanks-which-pool, other-thing and thanks-advice drew a
  // tool when recorded, so --broken cannot fail them.
  it('--broken: fails every case whose words matter and whose turn ran no tool, so the model is what is measured', () => {
    const out = run(['--cached-only', '--broken']);
    for (const id of ['hurt-wrist', 'thanks-call-pool', 'merci-call-fr']) {
      expect(out.stdout).toMatch(
        new RegExp(`^FAIL  ${id} .*calls=\\[(react_to_parent_message)?\\]`, 'm'),
      );
    }
  }, 120_000);

  it('refuses --broken without --cached-only, so calibration can never call the API', () => {
    const out = run(['--broken']);
    expect(out.status).toBe(2);
  }, 120_000);

  it('replays the recording when the prompt-cache layout flag reorders tools', () => {
    const out = run(['--cached-only', '--broken'], { PROMPT_CACHE_LAYOUT_ENABLED: 'true' });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('expected the words to go');
    expect(out.stdout).toMatch(/^FAIL {2}hurt-wrist .*calls=\[(react_to_parent_message)?\]/m);
    expect(out.stderr ?? '').not.toContain('cache miss');
  }, 120_000);
});
