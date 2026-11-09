import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-613 · Grep proof. A gate that asks "does this text carry a link?" asks
 * `hasLinkShape` (or `hasLinkBeyond`). Each hand-written copy had its own list of
 * endings, and bare domains walked through most of them. A new hand-written link
 * regex in `apps/web/lib` fails this file.
 *
 * The files below are not gates. They find, strip or parse a link code put there, or
 * read a host from one, so they keep their own patterns. The count is exact, so a new
 * pattern in one of them fails too.
 */
const NOT_A_GATE: Readonly<Record<string, number>> = {
  // An absolute page URL from a tool result, or its host.
  'channel/activity/deep.ts': 1,
  'channel/activity/refute.ts': 3,
  'channel/activity/venue-pages.ts': 2,
  'format/http-url.ts': 1,
  'signup/browser-use/outcome.ts': 1,
  'signup/browser-use/proxy.ts': 1,
  'social/extract.ts': 2,
  'social/forward.ts': 1,
  // Sets the code-appended link aside before another check reads the prose.
  'channel/activity/followup-note.ts': 1,
  'channel/connect/aha-read.ts': 1,
  'channel/intake/connector-offer.ts': 1,
  'channel/intake/friend-voice.ts': 2,
  'channel/intake/live-lookup.ts': 1,
  'channel/intake/official-page.ts': 1,
  'channel/plan/compose.ts': 1,
  'channel/reconcile/sentences.ts': 1,
  'loop/voice/facts-lint.ts': 1,
  // Finds the one link code attached, to send it as a preview or rebuild it.
  'channel/coach/activity-links.ts': 2,
  'channel/linq/link-preview.ts': 2,
  'channel/outbound-transport.ts': 1,
  'channel/rec-morning/copy.ts': 1,
  // Linq's own rule for a new chat, mirrored at the transport.
  'channel/linq/transport.ts': 2,
  // Holds the reply's hosts to the pages search returned, by host.
  'channel/off-domain/answer.ts': 5,
  // A link the parent pasted, claimed by the router.
  'channel/router/handlers.ts': 1,
  // The Browser Use live-view credential, redacted wherever it is written.
  'signup/browser-use/live-view.ts': 1,
  // Follow-up: the coach-channel eval loads this file raw through tsx, and with the shared
  // module imported the loader stalls once the eval's other modules are loaded.
  'channel/coach/experience-card-tool.ts': 1,
  // A test helper that reads a recorded bubble.
  'testing/onboarding-live-rules.ts': 1,
};

const LIB = fileURLToPath(new URL('..', import.meta.url));
const SHARED = 'format/link-shape.ts';
// A scheme or `www.` written into a regex or RegExp string, punycode, a TLD list
// ("com|ca"), or a constant named for a link.
const LINK_PATTERN =
  /https\?:\\\/\\\/|https:\\\/\\\/|www\\\.|:\\\/\\\/|https\?:\/\/|xn--|\b(?:com\|ca|ca\|com)\b|const [A-Z_]*LINK[A-Z_]* *= *\//;
const COMMENT = /^\s*(?:\*|\/\/|\/\*)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function linkPatternLines(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const path of sources(LIB)) {
    const name = relative(LIB, path);
    if (name === SHARED) continue;
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !COMMENT.test(line) && LINK_PATTERN.test(line));
    if (lines.length > 0) found[name] = lines.map((line) => line.trim());
  }
  return found;
}

describe('one shared link check', () => {
  const found = linkPatternLines();

  it('no gate in apps/web/lib writes its own link regex', () => {
    const counts = Object.fromEntries(
      Object.entries(found).map(([name, lines]) => [name, lines.length]),
    );
    expect(counts).toEqual(NOT_A_GATE);
  });

  it('positive control: the scan sees a hand-written gate and the shared module', () => {
    expect(LINK_PATTERN.test('const LINK_SHAPE = /https?:\\/\\/|www\\./i;')).toBe(true);
    expect(LINK_PATTERN.test("if (/https?:\\/\\//i.test(body)) return null;")).toBe(true);
    expect(LINK_PATTERN.test('const BARE = /\\b[a-z0-9-]+\\.(?:com|ca|org)\\b/i;')).toBe(true);
    const shared = readFileSync(join(LIB, SHARED), 'utf8');
    expect(shared.split('\n').some((line) => LINK_PATTERN.test(line))).toBe(true);
  });
});
