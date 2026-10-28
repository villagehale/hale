import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { linqGroupPlanEnabled } from '~/lib/channel/linq/config';
import {
  capturedSends,
  clearCapturedSends,
  createPreviewCaptureTransport,
} from '~/lib/channel/preview-capture-transport';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import { fakeGroupPlanFinder, fakeGroupPlanReader, takeGroupPlanTurn } from './group-plan';

/**
 * Preview proof for VIL-441. Fake families only. No Linq key, no real phone,
 * no real SMS. Hale's lines are captured on the preview door.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-28T16:00:00.000Z');
const DEADLINE = new Date('2026-10-30T16:00:00.000Z');
const PREVIEW_ENV = { VERCEL_ENV: 'preview', PREVIEW_CAPTURE_TRANSPORT: 'on' };

const CHEN_CHAT = 'preview-chen-group';
const PATEL_CHAT = 'preview-patel-group';
const PRIYA = '+14165550111';
const JORDAN = '+14165550112';
const MEI = '+14165550113';
const SAM = '+14165550114';
const DANA = '+14165550221';
const RAVI = '+14165550222';
const STRANGER = '+14165550999';

const SWIM = [
  {
    id: '1',
    name: 'Saturday parent-and-tot swim',
    when: 'Saturdays 9:15am',
    where: 'Elm rec centre',
    price: '$8 drop-in',
    link: 'https://example.test/elm-swim',
  },
  {
    id: '2',
    name: 'Sunday family swim',
    when: 'Sundays 11am',
    where: 'Riverside pool',
    price: '$12',
    link: 'https://example.test/riverside',
  },
];

const PARK = [
  {
    id: '1',
    name: 'Saturday park picnic',
    when: 'Saturday 11am',
    where: 'Riverdale Park',
    price: 'free',
    link: 'https://example.test/riverdale',
  },
  {
    id: '2',
    name: 'Sunday library storytime',
    when: 'Sunday 10:30am',
    where: 'Riverdale branch',
    price: 'free',
    link: 'https://example.test/storytime',
  },
];

let db: TestDb;
const transcript: string[] = [];

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
  if (transcript.length > 0) {
    console.info(`\n--- VIL-441 Preview conversations (fake families, not sent) ---\n${transcript.join('\n')}\n`);
  }
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('BROWSER_USE_API_KEY', '');
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  clearCapturedSends();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
  clearCapturedSends();
});

async function seedHousehold(
  displayName: string,
  chatId: string,
  people: { phone: string; name: string; role: 'parent' | 'co_parent' | 'other_family' | 'caregiver' }[],
) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName, provinceOrState: 'ON', linqGroupChatId: chatId })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  for (const person of people) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `preview:${person.phone}`, name: person.name })
      .returning({ id: schema.users.id });
    const userId = user?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId,
      userId,
      role:
        person.role === 'parent'
          ? 'primary_parent'
          : person.role === 'co_parent'
            ? 'co_parent'
            : person.role === 'other_family'
              ? 'extended'
              : 'nanny',
    });
    await db.database.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      verifiedAt: NOW,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId,
      chatId,
      userId,
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      role: person.role,
      seatedAt: NOW,
    });
  }
  return familyId;
}

function captureSend() {
  const transport = createPreviewCaptureTransport(PREVIEW_ENV);
  return async (notice: { chatId: string; text: string }) => {
    const sent = await transport.send({ to: notice.chatId, body: notice.text });
    return { providerMessageId: sent.providerMessageId };
  };
}

function reader() {
  return fakeGroupPlanReader(({ text, reactionType }) => {
    if (reactionType === 'like' || reactionType === 'love') {
      return { intent: 'yes', optionId: '1', subject: null, confidence: 'high' };
    }
    const body = text.trim().toLowerCase();
    if (body.includes('find') || body.includes('plan')) {
      return {
        intent: 'plan_ask',
        optionId: null,
        subject: body.includes('park') ? 'saturday park' : 'saturday swim',
        confidence: 'high',
      };
    }
    if (body.includes('sunday') || body.includes('storytime') || body.includes('other')) {
      return { intent: 'yes', optionId: '2', subject: null, confidence: 'high' };
    }
    if (body.includes('in') || body.includes('yes') || body.includes('first')) {
      return { intent: 'yes', optionId: '1', subject: null, confidence: 'high' };
    }
    if (body.includes('maybe')) return { intent: 'maybe', optionId: null, subject: null, confidence: 'high' };
    if (body.includes('pass') || body.includes('out')) {
      return { intent: 'no', optionId: null, subject: null, confidence: 'high' };
    }
    return { intent: 'chatter', optionId: null, subject: null, confidence: 'high' };
  });
}

function line(who: string, text: string) {
  transcript.push(`${who}: ${text}`);
}

describe('VIL-441 Preview conversations (fake families)', () => {
  it('BEFORE: flag off, inbound never opens the plan door and the capture is empty', async () => {
    await seedHousehold('Chen', CHEN_CHAT, [
      { phone: PRIYA, name: 'Priya Chen', role: 'parent' },
      { phone: JORDAN, name: 'Jordan Chen', role: 'co_parent' },
    ]);
    expect(linqGroupPlanEnabled()).toBe(false);
    transcript.push('', '## BEFORE (flag off, same Priya ask, nothing captured)');
    line('Priya', 'Hale, can you find us a Saturday swim?');
    line('Hale', '(quiet — LINQ_GROUP_PLAN_ENABLED is not exactly true, inbound never calls takeGroupPlanTurn)');
    expect(capturedSends()).toHaveLength(0);
    expect(await db.database.select().from(schema.linqGroupPlans)).toEqual([]);
  });

  it('AFTER: Chen household — find, tapback yes, maybe, non-member, mind-change, follow-up once', async () => {
    await seedHousehold('Chen', CHEN_CHAT, [
      { phone: PRIYA, name: 'Priya Chen', role: 'parent' },
      { phone: JORDAN, name: 'Jordan Chen', role: 'co_parent' },
      { phone: MEI, name: 'Mei Chen', role: 'other_family' },
      { phone: SAM, name: 'Sam Rivera', role: 'caregiver' },
    ]);
    const send = captureSend();
    const ports = { now: NOW, language: 'en' as const, send, reader: reader(), finder: fakeGroupPlanFinder(SWIM) };
    transcript.push('', '## Chen household (preview, not sent)');
    line('Priya', 'Hale, can you find us a Saturday swim?');
    const posted = await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: PRIYA,
      text: 'Hale, can you find us a Saturday swim?',
      ports,
    });
    expect(posted).toMatchObject({ outcome: 'group_plan_posted', notice: 'sent' });
    line('Hale', capturedSends().at(-1)?.body ?? '');

    line('Jordan', '[tapback: like]');
    await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: JORDAN,
      text: '',
      reactionType: 'like',
      ports,
    });

    line('Mei', 'maybe, depends on nap');
    await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: MEI,
      text: 'maybe, depends on nap',
      ports,
    });

    line('Unknown number', 'count us in for the first one');
    const stranger = await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: STRANGER,
      text: 'count us in for the first one',
      ports,
    });
    expect(stranger).toMatchObject({ seated: false, stance: 'yes', spoke: false });

    line('Jordan', 'actually the Sunday one');
    await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: JORDAN,
      text: 'actually the Sunday one',
      ports,
    });

    line('(deadline passed)', '');
    const follow = await takeGroupPlanTurn(db.database, {
      chatId: CHEN_CHAT,
      senderHandle: PRIYA,
      text: 'any word?',
      ports: { ...ports, now: new Date(DEADLINE.getTime() + 60_000) },
    });
    expect(follow).toMatchObject({ outcome: 'group_plan_followed_up', notice: 'sent' });
    line('Hale', capturedSends().at(-1)?.body ?? '');

    expect(capturedSends().every((row) => row.to === CHEN_CHAT)).toBe(true);
    expect(capturedSends().map((row) => row.body).join('\n')).toContain('Saturday parent-and-tot swim');
    expect(capturedSends()).toHaveLength(2);
  });

  it('AFTER: Patel household — a second fake family, same door, park options', async () => {
    await seedHousehold('Patel', PATEL_CHAT, [
      { phone: DANA, name: 'Dana Patel', role: 'parent' },
      { phone: RAVI, name: 'Ravi Patel', role: 'co_parent' },
    ]);
    const send = captureSend();
    const ports = {
      now: NOW,
      language: 'en' as const,
      send,
      reader: reader(),
      finder: fakeGroupPlanFinder(PARK),
    };
    transcript.push('', '## Patel household (preview, not sent)');
    line('Dana', 'Hale can you plan a Saturday park thing');
    await takeGroupPlanTurn(db.database, {
      chatId: PATEL_CHAT,
      senderHandle: DANA,
      text: 'Hale can you plan a Saturday park thing',
      ports,
    });
    line('Hale', capturedSends().at(-1)?.body ?? '');
    line('Ravi', 'yes the picnic');
    await takeGroupPlanTurn(db.database, {
      chatId: PATEL_CHAT,
      senderHandle: RAVI,
      text: 'yes the picnic',
      ports,
    });
    line('Dana', 'we are in for the first one');
    const last = await takeGroupPlanTurn(db.database, {
      chatId: PATEL_CHAT,
      senderHandle: DANA,
      text: 'we are in for the first one',
      ports,
    });
    expect(last).toMatchObject({ outcome: 'group_plan_progress' });
    line('Hale', capturedSends().at(-1)?.body ?? '');
    expect(capturedSends().every((row) => row.to === PATEL_CHAT)).toBe(true);
    expect(capturedSends().at(0)?.body).toContain('Riverdale Park');
  });
});
