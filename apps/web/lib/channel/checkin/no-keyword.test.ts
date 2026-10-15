import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Grep proof. A parent-facing instruction to answer with a keyword cannot land
 * in this lane again without this file failing. Carrier STOP lives in opt-out.ts.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const KEYWORD = /\b(?:reply|text|send)\s+[A-Z]{2,}\b/;

describe('the evening check-in sources', () => {
  it('contain no reply, text, or send keyword instruction', () => {
    const hits: string[] = [];
    for (const name of readdirSync(HERE)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(HERE, name), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (KEYWORD.test(line)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('the evening check-in judge fixtures', () => {
  const fixturePath = fileURLToPath(
    new URL('../../../../../apps/worker/evals/evening-checkin-judge-fixtures.mjs', import.meta.url),
  );
  const source = readFileSync(fixturePath, 'utf8');

  it('cover a Chinese pace and one non-Latin script, and are not a CI eval', () => {
    expect(source).toContain('每天提醒我');
    expect(source).toContain('راسلني أقل من فضلك');
    expect(source).toContain('cadence_intent');
    expect(source).toContain('check_in_decision');

    const ci = readFileSync(
      fileURLToPath(new URL('../../../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    const pkg = readFileSync(
      fileURLToPath(new URL('../../../../../apps/worker/package.json', import.meta.url)),
      'utf8',
    );
    expect(ci).not.toContain('evening-checkin-judge');
    expect(pkg).not.toContain('evening-checkin-judge');
  });
});
