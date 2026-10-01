import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PARTNERSHIP_BOOKED_LINE_TODO, PARTNERSHIP_FAILED_LINE_TODO } from './copy';

const SIGNUP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SEND_PATH = ['run.ts', 'copy.ts', 'handoff.ts', 'report.ts', 'handler.ts'];

describe('partnership booking copy', () => {
  it('is a TODO-Design placeholder with no opt-out keyword', () => {
    for (const line of [PARTNERSHIP_BOOKED_LINE_TODO, PARTNERSHIP_FAILED_LINE_TODO]) {
      expect(line.startsWith('TODO-Design:')).toBe(true);
      expect(line).not.toMatch(/\bSTOP\b/);
    }
  });

  it('is never placed on a send path', () => {
    const files = readdirSync(SIGNUP_DIR).filter((name) => name.endsWith('.ts'));
    for (const name of SEND_PATH) expect(files).toContain(name);
    for (const name of SEND_PATH) {
      const source = readFileSync(`${SIGNUP_DIR}${name}`, 'utf8');
      expect(source, name).not.toContain('TODO-Design');
      expect(source, name).not.toContain(PARTNERSHIP_BOOKED_LINE_TODO);
      expect(source, name).not.toContain(PARTNERSHIP_FAILED_LINE_TODO);
      expect(source, name).not.toContain('PARTNERSHIP_BOOKED_LINE_TODO');
      expect(source, name).not.toContain('PARTNERSHIP_FAILED_LINE_TODO');
    }
  });
});
