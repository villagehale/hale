import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { noticeSharedGroupAdded } from './multi-family';
import type { ListChatHandles } from './roster';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

/**
 * VIL-727 — the join intro in a group several families share, over real Postgres.
 *
 * Lit, Hale's first line there is the join intro: no household named, the ground rules
 * code checked are true today, one ask (who each person is and which kid they are with),
 * and the same deny list and once-per-chat claim every shared line has. Dark, the shared
 * intro is unchanged.
 *
 * WHAT IS FAKED, and only this: the two composers (plumbing only, never prose; the words
 * are the eval's) and Linq's send and member list.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const CHAT = 'chat-shared-group';
const CHILD = 'Zephyrina';

const MEI = '+16415550101';
const TOM = '+16415550102';
const ADA = '+16415550201';
const PRIYA = '+16415550301';
const GUEST = '+16415550303';
const FIVE = [MEI, TOM, ADA, PRIYA, GUEST];
const SMALL = [MEI, ADA];

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
  vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', '');
  vi.stubEnv('GROUP_MAIL_NOTICE_ENABLED', '');
  vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', 'true');
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, families, users cascade',
  );
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

function listOf(handles: readonly string[]): ListChatHandles {
  return async () => ({ status: 'ok', handles: [...handles], isGroup: true });
}

async function seedParent(phone: string, name: string, familyId?: string) {
  let home = familyId;
  if (!home) {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: name, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    home = family?.id as string;
  }
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${phone}`, name })
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
  return { familyId: home, userId };
}

/** Three households; Ada's has a child whose name must never reach the shared chat. */
async function threeFamilies() {
  const mei = await seedParent(MEI, 'Mei');
  await seedParent(TOM, 'Tom', mei.familyId);
  const ada = await seedParent(ADA, 'Ada');
  await seedParent(PRIYA, 'Priya');
  await db.database.insert(schema.children).values({
    familyId: ada.familyId,
    name: CHILD,
    dateOfBirth: '2022-04-01',
  });
  return { mei, ada };
}

async function introRows() {
  return db.database
    .select({ templateKey: schema.channelMessages.templateKey })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.direction, 'out'));
}

async function unsentAudits() {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'group_line_unsent'));
}

describe('the shared-group join intro, lit', () => {
  it('names no household, states the true rules, and asks who people are and which kid', async () => {
    await threeFamilies();
    const wire = sender();
    const intro = fakeGroupOnboardingComposer();
    const shared = fakeSharedGroupComposer();

    const notice = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      { send: wire.send, listHandles: listOf(FIVE), composer: shared, joinIntroVoice: intro },
    );

    expect(notice).toMatchObject({ handled: true, outcome: 'intro', notice: 'sent' });
    expect(wire.texts).toHaveLength(1);
    expect(shared.calls).toHaveLength(0);
    const input = intro.calls[0]?.input;
    expect(input?.kind).toBe('join_intro');
    expect(input?.skill).toBe('group-join-intro');
    expect(input?.questions).toBe(1);
    expect(input?.mustMention).toEqual(['Hale']);
    expect(input?.facts).toEqual({
      audience: 'shared',
      knownParentName: null,
      adderName: null,
      // The shared turn is always the model's read. A private text is not promised:
      // joining does not consent a household to the aside.
      claims: ['reads_this_chat', 'email_never_shown', 'speaks_when_called', 'anyone_can_remove'],
      ask: 'who_and_kid',
    });
    expect(JSON.stringify(input)).not.toContain(CHILD);
    expect(await introRows()).toEqual([{ templateKey: 'linq:multi_family_intro' }]);
  });

  it('leaves removal out of a group too small for anyone to remove a member', async () => {
    await threeFamilies();
    const wire = sender();
    const intro = fakeGroupOnboardingComposer();

    await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: SMALL },
      { send: wire.send, listHandles: listOf(SMALL), joinIntroVoice: intro },
    );

    expect(intro.calls[0]?.input.facts.claims).not.toContain('anyone_can_remove');
    expect(wire.texts).toHaveLength(1);
  });

  it("refuses a line carrying any household's private token: nothing is sent", async () => {
    await threeFamilies();
    const wire = sender();
    const leaky = fakeGroupOnboardingComposer({
      body: `I'm Hale. I read this chat and keep ${CHILD}'s plans private. Who are you and which kid are you with?`,
    });

    const notice = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      { send: wire.send, listHandles: listOf(FIVE), joinIntroVoice: leaky },
    );

    expect(notice).toMatchObject({ handled: true, outcome: 'intro', notice: 'refused_text' });
    expect(wire.texts).toEqual([]);
    expect(await introRows()).toEqual([]);
    expect((await unsentAudits()).map((row) => row.after)).toEqual([
      { kind: 'join_intro', fallback: 'unusable', templateKey: 'linq:multi_family_intro' },
    ]);
  });

  it('sends nothing and audits when the model cannot write it', async () => {
    await threeFamilies();
    const wire = sender();

    const notice = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      {
        send: wire.send,
        listHandles: listOf(FIVE),
        joinIntroVoice: fakeGroupOnboardingComposer({ fail: true }),
      },
    );

    expect(notice).toMatchObject({ notice: 'refused_text' });
    expect(wire.texts).toEqual([]);
    expect((await unsentAudits()).map((row) => row.after)).toEqual([
      { kind: 'join_intro', fallback: 'model_failed', templateKey: 'linq:multi_family_intro' },
    ]);
  });

  it('is said once per chat: the second add signal sends nothing new', async () => {
    await threeFamilies();
    const wire = sender();
    const intro = fakeGroupOnboardingComposer();
    const ports = { send: wire.send, listHandles: listOf(FIVE), joinIntroVoice: intro };

    await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      ports,
    );
    const second = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      ports,
    );

    expect(second).toMatchObject({ notice: 'already_sent' });
    expect(wire.texts).toHaveLength(1);
    expect(await introRows()).toHaveLength(1);
  });
});

describe('the shared-group join intro, dark', () => {
  it('leaves the shared intro exactly as it was', async () => {
    vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', '');
    await threeFamilies();
    const wire = sender();
    const intro = fakeGroupOnboardingComposer();
    const shared = fakeSharedGroupComposer();

    const notice = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: FIVE },
      { send: wire.send, listHandles: listOf(FIVE), composer: shared, joinIntroVoice: intro },
    );

    expect(notice).toMatchObject({ handled: true, outcome: 'intro', notice: 'sent' });
    expect(intro.calls).toHaveLength(0);
    expect(shared.calls.map((call) => call.input.kind)).toEqual(['intro']);
    expect(await introRows()).toEqual([{ templateKey: 'linq:multi_family_intro' }]);
  });
});
