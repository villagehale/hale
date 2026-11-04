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
 * A sender that may address a 1:1 or a group sends through `sendFlooredChatMessage` /
 * `sendFlooredPoll` (linq/group-audience.ts). Both take a `FloorPass`, and only
 * `chatFloorAllows` mints one, for the chat it decided. So a sender cannot decide for
 * itself that a chat is a 1:1: whatever it reads (household rows, a holder lookup, a
 * caller's label), it has no pass to send with unless the floor gave it one.
 *
 * The raw sends (`sendLinqChatMessage(`, `sendLinqPoll(`) are a reviewed list, not a
 * search for spellings. A module may call one only if it sits on `GROUP_FLOOR_MODULES`
 * (group-only senders that ask the floor, or a door built on it, before each line),
 * `DIRECT_ONLY` (it never addresses a group, and says why), or `KNOWN_GROUP_BYPASS` (a
 * group sender another change owns). Every list is a ratchet: an entry whose module no
 * longer sends, a floor module that no longer asks the floor, or a bypass that now asks
 * it, fails until the entry is fixed. A pass made anywhere but group-audience.ts (a cast)
 * fails here, and is refused at send time too.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The modules that define the sends; group-audience.ts defines the floored ones. */
const SEND_DEFINITIONS = new Set([
  'apps/web/lib/channel/outbound-transport.ts',
  'apps/web/lib/channel/linq/transport.ts',
  'apps/web/lib/channel/linq/group-audience.ts',
]);

/** Calls that ask the floor before a group line: the floor, and the doors built on it. */
const FLOOR_DOORS = [
  'chatFloorAllows',
  'groupAudienceAllows',
  'deliverLinqGroupNotice',
  'familyOutboundTarget',
];

const GROUP_FLOOR_MODULES: Record<string, string> = {
  'apps/web/lib/channel/coparent/duty/asks.ts':
    "duty asks go to the family group through familyOutboundTarget('pickup_duty')",
  'apps/web/lib/channel/group-plan/send.ts':
    'the claimed family group, after groupAudienceAllows for the plan line',
  'apps/web/lib/channel/linq/carpool.ts':
    'group lines through deliverLinqGroupNotice; the driver send is a 1:1 with the group excluded',
  'apps/web/lib/channel/linq/family-outbound.ts':
    'the family-outbound door: groupAudienceAllows before any group target',
  'apps/web/lib/channel/linq/group-plan-rsvp/send.ts':
    'the claimed family group, after groupAudienceAllows with no skip path',
  'apps/web/lib/channel/linq/group.ts':
    'deliverLinqGroupNotice asks the floor; the did-not-open notice is the parent 1:1',
  'apps/web/lib/channel/linq/household-calendar.ts':
    "the family's group chat, after groupAudienceAllows for each household line",
  'apps/web/lib/loop/reminders/group/line.ts':
    'the family group reminder line, after groupAudienceAllows',
};

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

const SENDS = /\b(?:sendLinqChatMessage|sendLinqPoll)\s*(?:\(|as\b)/;
const FLOORED_SENDS = /\b(?:sendFlooredChatMessage|sendFlooredPoll)\s*\(/;
const FORGES_PASS = /\bas\s+(?:unknown\s+as\s+)?FloorPass\b|\bFLOOR_PASS\b/;
const ASKS_FLOOR = new RegExp(`\\b(?:${FLOOR_DOORS.join('|')})\\s*\\(`);
const DECIDES_GROUPNESS =
  /\bisHouseholdGroupChat\b|\b(?:isGroup|inGroup|is_group|in_group)\b|\bsurface\s*[!=]==?\s*['"](?:group|reply)['"]/;

type Classified = {
  sends: boolean;
  flooredSends: boolean;
  asksFloor: boolean;
  decidesGroupness: boolean;
  forgesPass: boolean;
};

function classify(text: string): Classified {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return {
    sends: SENDS.test(code),
    flooredSends: FLOORED_SENDS.test(code),
    asksFloor: ASKS_FLOOR.test(code),
    decidesGroupness: DECIDES_GROUPNESS.test(code),
    forgesPass: FORGES_PASS.test(code),
  };
}

function findings(rel: string, c: Classified): string[] {
  if (SEND_DEFINITIONS.has(rel)) return [];
  const out: string[] = [];
  const floored = rel in GROUP_FLOOR_MODULES;
  const direct = rel in DIRECT_ONLY;
  const known = rel in KNOWN_GROUP_BYPASS;
  if (c.sends && !floored && !direct && !known) {
    out.push(
      `${rel}: sends into a chat outside the floor; use sendFlooredChatMessage / sendFlooredPoll`,
    );
  }
  if ((floored || direct || known) && !c.sends) {
    out.push(`${rel}: listed but no longer sends; remove it`);
  }
  if (floored && !c.asksFloor) out.push(`${rel}: no longer asks the floor; it may not send raw`);
  if (known && c.asksFloor) out.push(`${rel}: now asks the floor; remove it from the bypass list`);
  if (c.forgesPass) out.push(`${rel}: makes a FloorPass itself; only chatFloorAllows mints one`);
  if (c.sends && c.decidesGroupness) {
    out.push(`${rel}: decides for itself whether the chat is a group; ask chatFloorAllows`);
  }
  return out;
}

function scan(): { findings: string[]; senders: string[]; flooredSenders: string[] } {
  const all: string[] = [];
  const senders: string[] = [];
  const flooredSenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const c = classify(readFileSync(file, 'utf8'));
      if (c.sends) senders.push(rel);
      if (c.flooredSends) flooredSenders.push(rel);
      all.push(...findings(rel, c));
    }
  }
  const listed = [GROUP_FLOOR_MODULES, DIRECT_ONLY, KNOWN_GROUP_BYPASS].flatMap(Object.keys);
  for (const rel of listed) {
    if (!existsSync(join(REPO_ROOT, rel))) all.push(`${rel}: listed but missing; remove it`);
  }
  return { findings: all, senders, flooredSenders };
}

const BYPASS_FIXTURE = 'apps/web/lib/channel/linq/new-sender.fixture.ts';
const OUTSIDE = `${BYPASS_FIXTURE}: sends into a chat outside the floor; use sendFlooredChatMessage / sendFlooredPoll`;

describe('every group line passes the family-chat floor', () => {
  const result = scan();

  it('positive control: the scanner sees the senders this PR moved onto the floor', () => {
    expect(result.flooredSenders).toEqual(
      expect.arrayContaining([
        'apps/web/lib/channel/coparent/duty/ack.ts',
        'apps/web/lib/channel/linq/poll.ts',
      ]),
    );
    expect(result.senders).toContain('apps/web/lib/channel/linq/group-plan-rsvp/send.ts');
    expect(result.senders).not.toContain('apps/web/lib/channel/linq/poll.ts');
    expect(result.senders).not.toContain('apps/web/lib/channel/coparent/duty/ack.ts');
  });

  it('negative control: a new module that sends with no floor and no list entry fails', () => {
    const fixture = [
      `import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';`,
      '// groupAudienceAllows( in a comment is not a floor call',
      `export const post = (chatId: string) => sendLinqChatMessage({ chatId, text: 'x' });`,
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(fixture))).toEqual([OUTSIDE]);
    const poll = 'await sendLinqPoll({ chatId, options, idempotencyKey });';
    expect(findings(BYPASS_FIXTURE, classify(poll))).toHaveLength(1);
  });

  it('positive control: the same raw send passes on a reviewed list', () => {
    const floored = [
      `const v = await groupAudienceAllows(db, chatId, 'event_logistics', list);`,
      'if (v.allowed) await sendLinqChatMessage({ chatId, text });',
    ].join('\n');
    const groupOnly = 'apps/web/lib/channel/linq/group-plan-rsvp/send.ts';
    expect(findings(groupOnly, classify(floored))).toEqual([]);
    const listed = 'apps/web/lib/channel/router/reply-transport.ts';
    expect(findings(listed, classify('sendLinqChatMessage({ chatId, text })'))).toEqual([]);
  });

  it('negative control: an unlisted raw send fails even beside a floor call (the holder-lookup skip)', () => {
    const holderSkip = [
      'const [holder] = await database.select({ id: schema.families.id }).from(schema.families)',
      '  .where(eq(schema.families.linqGroupChatId, args.chatId)).limit(1);',
      "const audience = !holder ? ({ allowed: true, reason: 'direct' } as const)",
      '  : await chatFloorAllows(database, { chatId, recipientUserId, lineClass, listChatHandles });',
      'if (audience.allowed) await sendLinqPoll({ chatId, options, idempotencyKey });',
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(holderSkip))).toEqual([OUTSIDE]);
    const aliased = `import { sendLinqPoll as post } from '~/lib/channel/outbound-transport';`;
    expect(findings(BYPASS_FIXTURE, classify(aliased))).toEqual([OUTSIDE]);
    const groupOnly = 'apps/web/lib/channel/linq/group-plan-rsvp/send.ts';
    expect(findings(groupOnly, classify('sendLinqChatMessage({ chatId, text })'))).toEqual([
      `${groupOnly}: no longer asks the floor; it may not send raw`,
    ]);
  });

  it('negative control: a pass made outside group-audience.ts fails', () => {
    const forged = [
      'const pass = { chatId } as unknown as FloorPass;',
      'await sendFlooredChatMessage(pass, { chatId, text });',
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(forged))).toEqual([
      `${BYPASS_FIXTURE}: makes a FloorPass itself; only chatFloorAllows mints one`,
    ]);
  });

  it('negative control: a listed raw sender that switches the floor on its own group-ness signal fails', () => {
    const groupOnly = 'apps/web/lib/channel/linq/group-plan-rsvp/send.ts';
    const decided = `${groupOnly}: decides for itself whether the chat is a group; ask chatFloorAllows`;
    const byRows = [
      'if (await isHouseholdGroupChat(db, chatId)) {',
      `  await groupAudienceAllows(db, chatId, 'event_logistics', list);`,
      '}',
      'await sendLinqPoll({ chatId, options, idempotencyKey });',
    ].join('\n');
    expect(findings(groupOnly, classify(byRows))).toEqual([decided]);
    const byLabel = [
      `const v = input.surface === 'group' ? await groupAudienceAllows(db, c, 'pickup_duty', l) : null;`,
      'await sendLinqChatMessage({ chatId: c, text });',
    ].join('\n');
    expect(findings(groupOnly, classify(byLabel))).toEqual([decided]);
    const byBit =
      'if (inbound.isGroup) await groupAudienceAllows(db, c, "schedule", l);\nsendLinqChatMessage(x);';
    expect(findings(groupOnly, classify(byBit))).toEqual([decided]);
    expect(findings('apps/web/lib/channel/router/reply-transport.ts', classify(byBit))).toEqual([
      'apps/web/lib/channel/router/reply-transport.ts: decides for itself whether the chat is a group; ask chatFloorAllows',
    ]);
  });

  it('positive control: an unlisted sender passes when it sends with the pass chatFloorAllows gave it', () => {
    const decided = [
      'const v = await chatFloorAllows(db, { chatId, recipientUserId, lineClass, listChatHandles });',
      'if (v.allowed) await sendFlooredChatMessage(v.pass, { chatId, text });',
    ].join('\n');
    expect(findings(BYPASS_FIXTURE, classify(decided))).toEqual([]);
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
    const lists = [GROUP_FLOOR_MODULES, DIRECT_ONLY, KNOWN_GROUP_BYPASS];
    for (const reason of lists.flatMap(Object.values)) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(reason).not.toContain('\n');
    }
  });

  it('no module reaches a chat without the floor, unless it is listed', () => {
    expect(result.findings, result.findings.join('\n')).toEqual([]);
  });
});
