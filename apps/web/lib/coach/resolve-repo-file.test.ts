import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findRepoFile, resolveRepoFile } from './resolve-repo-file';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const PDF_WORKER = 'apps/web/lib/registration/pdf-worker.mjs';

describe('repo file resolution', () => {
  it('walks past a build path that no longer exists to the runtime module dir', () => {
    expect(
      findRepoFile(
        [
          '/nonexistent-build-root/apps/web/lib/registration',
          join(repoRoot, 'apps/web/lib/registration'),
        ],
        PDF_WORKER,
      ),
    ).toBe(join(repoRoot, PDF_WORKER));
    expect(findRepoFile(['/nonexistent-build-root'], PDF_WORKER)).toBeNull();
  });

  it('keeps resolveRepoFile for skills and prompts, with its unchanged error', () => {
    expect(resolveRepoFile('packages/agent/skills/reminder.md')).toBe(
      join(repoRoot, 'packages/agent/skills/reminder.md'),
    );
    expect(() => resolveRepoFile('packages/agent/skills/no-such-skill.md')).toThrow(
      `resolveRepoFile: could not locate packages/agent/skills/no-such-skill.md from cwd=${process.cwd()}`,
    );
  });
});
