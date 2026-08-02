import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-147 · structural tripwire for the CHANNEL half of F14 verdict #8.
 *
 * A teen access grant authorizes ONE parent to read ONE scope, for a bounded time,
 * on the AUTHENTICATED IN-APP SURFACE. It is not a downgrade of the teen's
 * redaction everywhere. So every OUTBOUND path — anything that puts bytes in front
 * of a recipient Hale did not authenticate as the granted parent — must be provably
 * incapable of consulting a grant.
 *
 * That matters most where it is least obvious:
 *   - an MCP read is a disclosure to a THIRD-PARTY MODEL, not to the parent;
 *   - an email/SMS/push lands on a device the granted parent may not be holding;
 *   - an ICS feed/invite is subscribed to by whoever holds the URL;
 *   - a PIPEDA export is a durable file that outlives the grant window;
 *   - a public party/village page has no viewer identity at all.
 *
 * A code-trace review cannot keep this true as the codebase grows, so it is a test:
 * importing the grant reader into any of these trees fails here, loudly, with the
 * reason. If a future change genuinely needs one of these to be grant-aware, that is
 * a deliberate privacy decision — it must move the file off this list on purpose.
 */

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** The grant-reading surface. Any of these in an outbound file is the bug. */
const GRANT_READER_TOKENS = [
  'loadTeenAccessUnlocks',
  'loadViewerTeenUnlocks',
  'redactsTeenContent',
  'activeTeenGrant',
  'teenAccessUnlocksFrom',
  'isTeenGrantActive',
  'teenAccessGrants',
];

/** Trees whose whole job is to emit something outward. */
const OUTBOUND_TREES = [
  ['lib/mcp', 'an MCP read discloses to a third-party model, never to the granted parent'],
  ['lib/loop/templates', 'email/SMS/push copy renders for a device, not an authenticated session'],
  ['lib/loop/voice', 'model-authored copy must never be handed unlocked teen content'],
  ['lib/channel', 'an outbound channel message has no authenticated in-app viewer'],
  ['lib/rights', 'a PIPEDA export is a durable file that outlives the grant window'],
  ['lib/party', 'the public party page has no viewer identity at all'],
  ['app/api/mcp', 'the MCP endpoint answers a third-party client'],
  ['app/api/ics', 'an ICS feed is subscribed to by whoever holds the URL'],
];

/** Individual outbound files that live inside otherwise-mixed trees. */
const OUTBOUND_FILES = [
  ['lib/loop/ics-feed.ts', 'an ICS feed is subscribed to by whoever holds the URL'],
  ['lib/loop/ics-invite.ts', 'an ICS invite is delivered to arbitrary attendees'],
  ['lib/loop/compose.ts', 'the loop composer bakes the artifact every outbound send reads'],
  ['lib/loop/assistant-events.ts', 'the assistant projection feeds the MCP read path'],
  ['lib/cron/digest-tools.ts', 'the daily digest is an email, not a session'],
  ['lib/cron/push-reminders.ts', 'a push notification lands on a lock screen'],
  ['lib/cron/inference-tools.ts', 'memory distillation feeds prompts, not a parent'],
  ['lib/telemetry/mask.ts', 'trace masking is the last backstop before Langfuse'],
  ['lib/village/public.ts', 'a public village page has no viewer identity'],
  ['lib/village/public-picks.ts', 'a public picks page has no viewer identity'],
];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function offendingTokens(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return GRANT_READER_TOKENS.filter((token) => source.includes(token));
}

describe('teen access grants never reach an outbound channel', () => {
  for (const [tree, why] of OUTBOUND_TREES) {
    it(`${tree} consults no grant — ${why}`, () => {
      const files = walk(`${WEB_ROOT}/${tree}`);
      // Guard the guard: a mistyped path would silently assert nothing.
      expect(files.length).toBeGreaterThan(0);

      const offenders = files
        .map((file) => ({ file: file.slice(WEB_ROOT.length + 1), tokens: offendingTokens(file) }))
        .filter((entry) => entry.tokens.length > 0);

      expect(offenders).toEqual([]);
    });
  }

  for (const [file, why] of OUTBOUND_FILES) {
    it(`${file} consults no grant — ${why}`, () => {
      const source = readFileSync(`${WEB_ROOT}/${file}`, 'utf8');
      expect(source.length).toBeGreaterThan(0);
      expect(GRANT_READER_TOKENS.filter((token) => source.includes(token))).toEqual([]);
    });
  }

  it('the PIPEDA export calls the trail loader WITHOUT an unlock set', () => {
    // loadTrailForFamily takes `unlocks` as an optional third argument defaulting to
    // NO_TEEN_UNLOCKS. The export must never pass one, so its trail always renders at
    // the most-private level — asserted on the source, so a future edit that starts
    // passing an unlock set has to delete this test on purpose.
    const source = readFileSync(`${WEB_ROOT}/lib/rights/export.ts`, 'utf8');
    const call = source.match(/await loadTrail\(([^)]*)\)/);
    expect(call).not.toBeNull();
    expect(call?.[1]?.split(',').map((a) => a.trim())).toEqual(['database', 'familyId']);
  });
});
