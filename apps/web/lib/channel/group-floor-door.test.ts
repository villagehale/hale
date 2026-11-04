import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every line Hale posts into a family group passes the family-chat floor
 * (`groupAudienceAllows`, linq/group-audience.ts). capture-door.test.ts asks "can this
 * send skip the capture switch?"; this test asks "can this send reach a group without
 * the floor?".
 *
 * A module that calls `sendLinqChatMessage(` or `sendLinqPoll(` must also call the
 * floor itself or through a door that asks it (`FLOOR_DOORS`), or sit on `DIRECT_ONLY`
 * (it never addresses a group, and says why), or on `KNOWN_GROUP_BYPASS` (a group sender
 * another change owns). Both lists are ratchets: an entry whose module no longer calls a
 * send, or a bypass that now asks the floor, fails until it is removed.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The modules that define the sends. */
const SEND_DEFINITIONS = new Set([
  'apps/web/lib/channel/outbound-transport.ts',
  'apps/web/lib/channel/linq/transport.ts',
]);

/** Calls that ask the floor before a group line: the floor, and the doors built on it. */
const FLOOR_DOORS = ['groupAudienceAllows', 'deliverLinqGroupNotice', 'familyOutboundTarget'];

const DIRECT_ONLY: Record<string, string> = {
  'apps/web/lib/channel/calendar-write/send.ts':
    'the parent 1:1 door from resolveMessagingDoor with the family group excluded',
  'apps/web/lib/channel/connect/connected-notice.ts':
    'the receipt chat is imessageChatOutsideGroup: never a family group',
  'apps/web/lib/channel/connect/fresh-link.ts':
    'the parent 1:1 door from resolveMessagingDoor with the family group excluded',
  'apps/web/lib/channel/router/reply-transport.ts':
    'the 1:1 router reply door; group turns route through linq/inbound.ts',
};

const KNOWN_GROUP_BYPASS: Record<string, string> = {
  'apps/web/lib/channel/linq/group-coparent.ts':
    'VIL-399 PR 1 (queued) owns this file; its group lines move onto the floor there',
  'apps/web/lib/channel/linq/group-members.ts':
    'VIL-399 PR 1 (queued) owns this file; its group lines move onto the floor there',
  'apps/web/lib/channel/linq/group-onboarding-voice.ts':
    "roster asks and acknowledgements (identity tier); a 'reply' floor here would hold roster_pending asks, a follow-up",
  'apps/web/lib/channel/linq/multi-family.ts':
    'multi-family chats have no household roster; their floor is a follow-up',
};

const SCAN_ROOTS = ['apps/web/app', 'apps/web/lib'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const SENDS = /\b(?:sendLinqChatMessage|sendLinqPoll)\s*\(/;
const ASKS_FLOOR = new RegExp(`\\b(?:${FLOOR_DOORS.join('|')})\\s*\\(`);

type Classified = { sends: boolean; asksFloor: boolean };

function classify(text: string): Classified {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return { sends: SENDS.test(code), asksFloor: ASKS_FLOOR.test(code) };
}

function findings(rel: string, c: Classified): string[] {
  if (SEND_DEFINITIONS.has(rel)) return [];
  const out: string[] = [];
  const direct = rel in DIRECT_ONLY;
  const known = rel in KNOWN_GROUP_BYPASS;
  if (c.sends && !c.asksFloor && !direct && !known) {
    out.push(`${rel}: sends into a chat without the family-chat floor`);
  }
  if ((direct || known) && !c.sends) out.push(`${rel}: listed but no longer sends; remove it`);
  if (known && c.asksFloor) out.push(`${rel}: now asks the floor; remove it from the bypass list`);
  return out;
}

function scan(): { findings: string[]; senders: string[] } {
  const all: string[] = [];
  const senders: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const c = classify(readFileSync(file, 'utf8'));
      if (c.sends) senders.push(rel);
      all.push(...findings(rel, c));
    }
  }
  for (const rel of [...Object.keys(DIRECT_ONLY), ...Object.keys(KNOWN_GROUP_BYPASS)]) {
    if (!existsSync(join(REPO_ROOT, rel))) all.push(`${rel}: listed but missing; remove it`);
  }
  return { findings: all, senders };
}

const BYPASS_FIXTURE = 'apps/web/lib/channel/linq/new-sender.fixture.ts';

describe('every group line passes the family-chat floor', () => {
  const result = scan();

  it('positive control: the scanner sees the senders this PR moved onto the floor', () => {
    expect(result.senders).toEqual(
      expect.arrayContaining([
        'apps/web/lib/channel/coparent/duty/ack.ts',
        'apps/web/lib/channel/linq/poll.ts',
        'apps/web/lib/channel/linq/group-plan-rsvp/send.ts',
      ]),
    );
  });

  it('negative control: a new module that sends with no floor and no list entry fails', () => {
    const fixture = [
      `import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';`,
      '// groupAudienceAllows( in a comment is not a floor call',
      `export const post = (chatId: string) => sendLinqChatMessage({ chatId, text: 'x' });`,
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(fixture))).toEqual([
      `${BYPASS_FIXTURE}: sends into a chat without the family-chat floor`,
    ]);
    const poll = 'await sendLinqPoll({ chatId, options, idempotencyKey });';
    expect(findings(BYPASS_FIXTURE, classify(poll))).toHaveLength(1);
  });

  it('positive control: the same sender passes when it asks the floor or is listed direct-only', () => {
    const floored = [
      `const v = await groupAudienceAllows(db, chatId, 'event_logistics', list);`,
      'if (v.allowed) await sendLinqChatMessage({ chatId, text });',
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(floored))).toEqual([]);
    const listed = 'apps/web/lib/channel/router/reply-transport.ts';
    expect(findings(listed, classify('sendLinqChatMessage({ chatId, text })'))).toEqual([]);
  });

  it('ratchet: a listed bypass that now asks the floor, or a stale entry, fails', () => {
    const known = 'apps/web/lib/channel/linq/multi-family.ts';
    expect(
      findings(known, classify('groupAudienceAllows(db, c, "reply", l); sendLinqChatMessage(x)')),
    ).toEqual([`${known}: now asks the floor; remove it from the bypass list`]);
    expect(findings(known, classify('export const nothing = 1;'))).toEqual([
      `${known}: listed but no longer sends; remove it`,
    ]);
  });

  it('every reason is one line', () => {
    for (const reason of [...Object.values(DIRECT_ONLY), ...Object.values(KNOWN_GROUP_BYPASS)]) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(reason).not.toContain('\n');
    }
  });

  it('no module reaches a chat without the floor, unless it is listed', () => {
    expect(result.findings, result.findings.join('\n')).toEqual([]);
  });
});
