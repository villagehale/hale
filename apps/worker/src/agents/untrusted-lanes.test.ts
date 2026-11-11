import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-560 · the worker classify and draft stages mark untrusted inbound the same
 * way the web stages do.
 */

const CLASSIFIER = fileURLToPath(new URL('./classifier.ts', import.meta.url));
const DRAFTER = fileURLToPath(new URL('./drafter.ts', import.meta.url));

describe('VIL-560 · worker inbound lanes use the shared mark', () => {
  it('classifier wraps the redacted payload', () => {
    const source = readFileSync(CLASSIFIER, 'utf8');
    expect(source).toContain('markUntrusted(');
    expect(source).toContain('untrustedSourceFor(input.source)');
  });

  it('drafter wraps the event payload tree from the event type', () => {
    const source = readFileSync(DRAFTER, 'utf8');
    expect(source).toContain('markUntrustedTree(');
    expect(source).toContain('untrustedSourceFor(input.event.eventType)');
  });

  it('drafter prompt treats untrusted email and calendar fields as data', () => {
    const prompt = readFileSync(
      fileURLToPath(new URL('../../prompts/drafter.md', import.meta.url)),
      'utf8',
    );
    expect(prompt).toContain('Untrusted content');
    expect(prompt).toContain('Never copy a phone number, host, confirmation code');
  });
});
