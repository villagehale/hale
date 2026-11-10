import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from './lib/harness.mjs';
import { LINQ_EDIT_FIXTURES, LINQ_EDIT_NEEDS_RERECORD } from './linq-edit-fixtures.mjs';
import { linqEditRecordingTag, linqEditRerecordGate } from './run-linq-edit-eval.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-linq-edit-eval.mjs');

function run(flag) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return spawnSync(process.execPath, [RUNNER, flag], { env, encoding: 'utf8', timeout: 120_000 });
}

describe('VIL-479 linq-edit eval modes never spend', () => {
  it('--broken: the known-bad stand-in fails the run on the send gate alone', () => {
    const out = run('--broken');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('unsendable:unknown_message');
    expect(out.stdout).toContain('live API calls: 0');
  }, 120_000);

  it('--dry and --estimate: print the worst-case price and write nothing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const dry = run('--dry');
    const estimate = run('--estimate');
    expect(dry.status).toBe(0);
    expect(estimate.status).toBe(0);
    expect(dry.stdout).toMatch(/worst case to record \d+ fixtures.*\$\d+\.\d{4} USD/);
    expect(estimate.stdout).toBe(dry.stdout);
    expect(dry.stdout).toContain('live API calls: 0');
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);

  it('refuses to run with no mode, so nothing calls the API by default', () => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const out = spawnSync(process.execPath, [RUNNER], { env, encoding: 'utf8' });
    expect(out.status).toBe(2);
  }, 120_000);
});

describe('linq-edit recordings are keyed on the tool description', () => {
  it('a changed description is a new recording, not a replay of the old decision', () => {
    const before = linqEditRecordingTag('correct-time', 'edit is null, or one part.');
    expect(linqEditRecordingTag('correct-time', 'edit is null, or one part.')).toBe(before);
    expect(linqEditRecordingTag('correct-time', 'Only edit to correct a fact.')).not.toBe(before);
    expect(linqEditRecordingTag('correct-venue', 'edit is null, or one part.')).not.toBe(before);
  });
});

describe('linq-edit writer cases waiting on the French re-record', () => {
  const knownIds = LINQ_EDIT_FIXTURES.map((fixture) => fixture.id);

  it('lists every fixture until the batched re-record, and no unknown ids', () => {
    expect([...LINQ_EDIT_NEEDS_RERECORD].sort()).toEqual([...knownIds].sort());
  });

  it('a listed miss is expected; a listed hit is stale; an unlisted miss fails', () => {
    const pendingAll = linqEditRerecordGate({
      pending: knownIds,
      stale: [],
      listed: LINQ_EDIT_NEEDS_RERECORD,
      knownIds,
    });
    expect(pendingAll.ok).toBe(true);
    expect(pendingAll.expectedPending).toEqual(knownIds);
    expect(pendingAll.lines.join('\n')).toContain('need-rerecord');

    const stale = linqEditRerecordGate({
      pending: [],
      stale: ['correct-time'],
      listed: LINQ_EDIT_NEEDS_RERECORD,
      knownIds,
    });
    expect(stale.ok).toBe(false);
    expect(stale.lines.join('\n')).toContain('still hits cache');

    const surprise = linqEditRerecordGate({
      pending: ['correct-time'],
      stale: [],
      listed: [],
      knownIds,
    });
    expect(surprise.ok).toBe(false);
    expect(surprise.lines.join('\n')).toContain('unexpected writer cache miss');
  });
});
