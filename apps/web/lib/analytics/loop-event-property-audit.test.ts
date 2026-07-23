import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * X1 (VIL-227) acceptance criterion: "No PII in analytics payloads (phone/body/
 * child names excluded — property audit test)". `buildEvent` already redacts any
 * forbidden-fragment key at RUNTIME (events.test.ts), but a silent drop is not a
 * loud failure — someone could add `{ phone }` to a loop_* call site and every
 * existing test would stay green. This reads each known loop_* capture call site
 * as TEXT and asserts its property-literal keys are drawn only from an explicit
 * whitelist, so the same mistake fails CI instead of quietly losing a property.
 *
 * Deliberately source-coupled (mirrors mobile/childcare-category-parity.test.ts):
 * each pattern pins the exact call shape. A refactor that changes the shape makes
 * the match fail — a maintainer must touch this file too, which is the point: the
 * audit stays intentional rather than silently stale.
 */

const ALLOWED_LOOP_EVENT_PROPERTY_KEYS = new Set([
  'channel',
  'category',
  'templateKey',
  'reason',
  'items',
  'pending',
  'actionType',
]);

interface AuditTarget {
  file: string;
  event: string;
  /** Capture group 1 = the property-literal body (between the outer `{` `}`) at
   * this file's loop_* capture call site. */
  pattern: RegExp;
}

const TARGETS: AuditTarget[] = [
  {
    file: '../channel/dispatch.ts',
    event: 'loop_message_sent / loop_message_failed',
    pattern: /ports\.capture\(\s*event\s*,\s*msg\.parentUserId\s*,\s*\{([\s\S]*?)\}\s*\)/,
  },
  {
    file: '../loop/send.ts',
    event: 'loop_plan_sent',
    pattern: /deps\.capture\(\s*'loop_plan_sent'\s*,\s*parent\.userId\s*,\s*\{([\s\S]*?)\}\s*\)/,
  },
  {
    file: '../actions/reverse-calendar.ts',
    event: 'loop_undo',
    pattern: /capture\(\s*'loop_undo'\s*,\s*args\.revertedBy\s*,\s*\{([\s\S]*?)\}\s*\)/,
  },
  {
    file: '../loop/stop-alert.ts',
    event: 'loop_stop',
    pattern: /captureServerEvent\(\s*'loop_stop'\s*,\s*input\.userId\s*,\s*\{([\s\S]*?)\}\s*\)/,
  },
];

/** Splits a flat (non-nested) object-literal body on top-level commas and extracts
 * each entry's key — either `key: value` or the shorthand `key` (e.g. `{ channel,
 * category: msg.category }`). Every property object at the audited call sites is
 * kept flat on purpose (no nested literals/spreads) so this stays a reliable parse. */
function extractKeys(objectLiteralBody: string): string[] {
  return objectLiteralBody
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const match = entry.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|$)/);
      if (!match) {
        throw new Error(`could not parse a property key from entry: "${entry}"`);
      }
      return match[1] as string;
    });
}

describe('loop_* analytics property audit — every call site passes only whitelisted keys', () => {
  for (const target of TARGETS) {
    it(`${target.event} (${target.file}) carries no key outside the whitelist`, () => {
      const source = readFileSync(fileURLToPath(new URL(target.file, import.meta.url)), 'utf8');
      const match = source.match(target.pattern);
      expect(match, `expected to find the ${target.event} capture call in ${target.file}`).toBeTruthy();

      const keys = extractKeys(match?.[1] as string);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(ALLOWED_LOOP_EVENT_PROPERTY_KEYS.has(key), `unexpected property key "${key}" in ${target.file}`).toBe(
          true,
        );
      }
    });
  }

  it('the whitelist itself contains no PII-shaped key (defence in depth on the audit list itself)', () => {
    const forbiddenFragments = ['name', 'email', 'phone', 'address', 'dob', 'birth', 'child', 'teen', 'message', 'content', 'body', 'text', 'question', 'answer', 'note', 'location', 'ip', 'token'];
    for (const key of ALLOWED_LOOP_EVENT_PROPERTY_KEYS) {
      const lower = key.toLowerCase();
      for (const fragment of forbiddenFragments) {
        expect(lower.includes(fragment), `whitelisted key "${key}" looks identifying (matches "${fragment}")`).toBe(
          false,
        );
      }
    }
  });
});
