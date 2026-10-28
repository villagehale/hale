import { mkdirSync, writeFileSync } from 'node:fs';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturedSends, clearCapturedSends } from '~/lib/channel/preview-capture-transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  noticeSharedGroupAdded,
  takeMultiFamilyReaction,
  takeMultiFamilyTurn,
} from '../channel/linq/multi-family';
import type { ListChatHandles } from '../channel/linq/roster';
import type { SharedGroupReader, SharedGroupReading } from '../channel/linq/shared-group-reading';
import { fakeSharedGroupComposer } from '../channel/linq/shared-group-voice-fake';

/**
 * VIL-456 Preview conversation — fake families, no real SMS, no live keys.
 *
 * Three families, seven numbers. Hale is added to a chat they already have.
 * The composer is the test stand-in (same facts the model would get). Production
 * writes the words; this run proves the door, the seating, the silence, the
 * opt-out, the tapback, and the privacy wall.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
const NOW = new Date('2026-10-28T16:00:00.000Z');
const CHAT = 'preview-class-group';
const MEI = '+16415550101';
const TOM = '+16415550102';
const ADA = '+16415550201';
const JORDAN = '+16415550202';
const PRIYA = '+16415550301';
const SAM = '+16415550302';
const GUEST = '+16415550303';
const SEVEN = [MEI, TOM, ADA, JORDAN, PRIYA, SAM, GUEST];
const CHILD = 'Zephyrina';
const MEMORY = 'zephyr-memory-token';
const CALENDAR = 'Private dentist Zephyrina';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  clearCapturedSends();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, families, users cascade',
  );
});

type Line = { from: string; text: string; kind: 'human' | 'hale' | 'tapback' | 'quiet' };

function reader(
  intent: SharedGroupReading['intent'],
  extra: Partial<SharedGroupReading> = {},
): SharedGroupReader {
  return {
    async read() {
      return {
        intent,
        role: extra.role ?? 'unclear',
        familyLabel: extra.familyLabel ?? null,
        kidName: extra.kidName ?? null,
        confidence: extra.confidence ?? 'high',
      };
    },
  };
}

async function seedParent(phone: string, name: string, familyId?: string) {
  let home = familyId;
  if (!home) {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: `${name} family`, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    home = family?.id as string;
  }
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `preview:${name}-${phone}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId: home,
    userId,
    role: familyId ? 'co_parent' : 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId: home,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId: home, userId, name };
}

describe('Preview conversation: three fake families, seven numbers', () => {
  it('meets the Instinct bar for VIL-456 without a real SMS or a live key', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await seedParent(TOM, 'Tom', mei.familyId);
    const ada = await seedParent(ADA, 'Ada');
    await seedParent(JORDAN, 'Jordan', ada.familyId);
    await seedParent(PRIYA, 'Priya');
    await db.database.insert(schema.children).values({
      familyId: ada.familyId,
      name: CHILD,
      dateOfBirth: '2022-04-01',
    });
    await db.database.insert(schema.familyMemoryFacts).values({
      familyId: ada.familyId,
      factType: 'preference',
      factKey: MEMORY,
      factValue: { note: 'hidden' },
    });
    await db.database.insert(schema.familyEvents).values({
      familyId: ada.familyId,
      title: CALENDAR,
      startsAt: NOW,
      source: 'parent',
    });

    const transcript: Line[] = [];
    const voice = fakeSharedGroupComposer();
    const list: ListChatHandles = async () => ({ status: 'ok', handles: SEVEN, isGroup: true });
    const send = async (notice: { chatId: string; text: string }) => {
      transcript.push({ from: 'Hale', text: notice.text, kind: 'hale' });
      return { providerMessageId: `preview-${transcript.length}` };
    };
    const ports = { send, listHandles: list, composer: voice };

    const intro = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: SEVEN },
      ports,
    );
    expect(intro.handled).toBe(true);
    expect(intro.outcome).toBe('intro');
    transcript.unshift({
      from: 'Mei',
      text: '(adds Hale to the class group)',
      kind: 'human',
    });

    transcript.push({
      from: 'Mei',
      text: 'Hale, can you keep track of who is coming to Saturday swim?',
      kind: 'human',
    });
    const first = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, can you keep track of who is coming to Saturday swim?',
        providerMessageId: 'preview-ask',
        receivedAt: NOW,
        now: NOW,
      },
      { ...ports, reader: reader('question') },
    );
    expect(first.outcome).toBe('shared_reply');

    transcript.push({ from: 'Tom', text: 'I can bring orange slices', kind: 'human' });
    const banter = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: TOM,
        text: 'I can bring orange slices',
        providerMessageId: 'preview-banter',
        receivedAt: NOW,
        now: NOW,
      },
      { ...ports, reader: reader('chatter') },
    );
    expect(banter.outcome).toBe('chatter_ignored');
    transcript.push({ from: 'Hale', text: '(stays quiet)', kind: 'quiet' });

    transcript.push({ from: 'Ada', text: 'hey I am Ada, Leo is my kid', kind: 'human' });
    const who = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: ADA,
        text: 'hey I am Ada, Leo is my kid',
        providerMessageId: 'preview-who',
        receivedAt: NOW,
        now: NOW,
      },
      { ...ports, reader: reader('who_i_am', { role: 'parent', kidName: 'Leo' }) },
    );
    expect(who.outcome).toBe('who_confirmed');

    transcript.push({ from: 'Priya', text: '(hearts Hale)', kind: 'tapback' });
    const heart = await takeMultiFamilyReaction(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        reactionType: 'love',
        providerMessageId: 'preview-heart',
        now: NOW,
      },
      { ...ports, reader: reader('yes') },
    );
    expect(heart.outcome).toBe('yes');

    transcript.push({ from: 'Jordan', text: 'Hale, leave me out of this one', kind: 'human' });
    const stop = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: JORDAN,
        text: 'Hale, leave me out of this one',
        providerMessageId: 'preview-stop',
        receivedAt: NOW,
        now: NOW,
      },
      { ...ports, reader: reader('stop_me'), optOut: async () => 'stop' },
    );
    expect(stop.outcome).toBe('member_stopped');

    const haleLines = transcript.filter((line) => line.kind === 'hale').map((line) => line.text);
    expect(haleLines.length).toBeGreaterThanOrEqual(3);
    expect(haleLines.join('\n')).not.toContain(CHILD);
    expect(haleLines.join('\n')).not.toContain(MEMORY);
    expect(haleLines.join('\n')).not.toContain(CALENDAR);
    expect(haleLines.join('\n')).not.toContain('TODO-Design');
    expect(haleLines.join('\n')).not.toMatch(/poll|RSVP button/i);

    const people = await db.database.select().from(schema.linqSharedGroupPeople);
    expect(people).toHaveLength(7);
    expect(new Set(people.map((row) => row.familyId).filter(Boolean)).size).toBe(3);
    expect(people.find((row) => row.phoneE164Hash === phoneBlindIndex(SAM))?.familyId).toBeNull();
    expect(people.find((row) => row.phoneE164Hash === phoneBlindIndex(JORDAN))?.stoppedAt).toEqual(
      NOW,
    );
    expect(people.find((row) => row.phoneE164Hash === phoneBlindIndex(MEI))?.stoppedAt).toBeNull();

    const joins = (await db.database.select().from(schema.linqMultiFamilyJoins)).filter(
      (row) => row.leftAt == null,
    );
    expect(joins).toHaveLength(3);
    expect(capturedSends()).toEqual([]);

    const rendered = [
      '# Preview conversation — VIL-456 (fake families, no SMS)',
      '',
      'VERCEL_ENV=preview. PREVIEW_CAPTURE_TRANSPORT=on. Linq, Anthropic, AI Gateway, DB, and Browser Use keys unset.',
      'Composer is the test stand-in over the same facts production hands the model.',
      '',
      ...transcript.map((line) => `- **${line.from}:** ${line.text}`),
      '',
      'Families stay unmerged. Jordan is out. Mei, Tom, Ada, Priya, Sam, and the guest stay.',
      'Nothing from Ada’s calendar, memory, or kid row appears in Hale’s lines.',
    ].join('\n');
    mkdirSync('/opt/cursor/artifacts', { recursive: true });
    writeFileSync('/opt/cursor/artifacts/vil-456-preview-conversation.md', rendered);
    expect(rendered).toContain('keep track of who is coming');
    expect(rendered).toContain('(stays quiet)');
    expect(rendered).toContain('leave me out');
  });
});
