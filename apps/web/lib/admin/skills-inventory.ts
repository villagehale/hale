import skillsLock from '../../../../packages/agent/skills/.skills-lock.json';

/**
 * The agent skills inventory, read from the lock file the drift gate already
 * maintains. Imported as JSON so it is BUNDLED at build time — no fs read at
 * runtime, no outputFileTracingIncludes, no API to be down.
 */
export interface SkillRow {
  name: string;
  /** Short content hash for the table; the full sha256 stays in the title. */
  shaShort: string;
  sha256: string;
}

export function skillsInventory(): SkillRow[] {
  return Object.entries(skillsLock as Record<string, { file?: string; sha256?: string }>)
    .map(([name, entry]) => {
      const sha256 = entry.sha256 ?? '';
      return { name: name.replace(/\.md$/, ''), shaShort: sha256.slice(0, 12), sha256 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
