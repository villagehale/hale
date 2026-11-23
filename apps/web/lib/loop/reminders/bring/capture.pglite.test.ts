import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COACH_CALENDAR_INTEGRATION_ID,
  handleEmailAlertOfferReply,
  loadOpenEmailAlertOffers,
  recordCoachCalendarOffer,
  recordEmailAlertOffer,
} from '~/lib/integrations/email-alert-offer';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type EmailBringInput, type EmailBringPorts, captureEmailBringItems } from './email';
import { type CoachBringInput, captureCoachOfferBringItems } from './photo';
import type { BringItemsInput, BringItemsRead, BringItemsReader } from './read';
import { bringSourceRef, loadBringItemsFor } from './store';

/**
 * VIL-720 · the two places a bring list is captured (an email in the Gmail alert, a flyer
 * after a coach offer) and the yes that attaches a pending one, on a real Postgres. The
 * reader is a scripted BringItemsReader: these tests are about where a reading goes, never
 * about what the model reads (that is run-bring-items-eval.mjs). Every id, title and item
 * is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;

const NOW = new Date('2026-11-18T15:00:00.000Z');
const STARTS_AT = new Date('2026-11-21T14:30:00.000Z');
const INTEGRATION = '22222222-2222-4000-8000-000000000720';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', 'true');
  vi.stubEnv('VOICE_DISABLED', 'true');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function scripted(read: BringItemsRead) {
  const inputs: BringItemsInput[] = [];
  const reader: BringItemsReader = async (input) => {
    inputs.push(input);
    return read;
  };
  return { reader, inputs };
}

async function seedEvent(): Promise<string> {
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title: 'Swim lessons', startsAt: STARTS_AT, source: 'placement' })
    .returning({ id: schema.familyEvents.id });
  if (!event) throw new Error('no event');
  return event.id;
}

async function sentOut(): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'connector:email_alert',
      dedupeKey: `email_alert:${randomUUID()}:m1`,
      status: 'sent',
      sentAt: NOW,
      createdAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no ledger row');
  return row.id;
}

function bringRows() {
  return db.database
    .select()
    .from(schema.familyEventBringItems)
    .where(eq(schema.familyEventBringItems.familyId, familyId));
}

function emailInput(over: Partial<EmailBringInput> = {}): EmailBringInput {
  return {
    familyId,
    parentUserId,
    integrationId: INTEGRATION,
    messageId: 'gmail-msg-1',
    envelope: { subject: 'Swim starts Saturday', from: 'swim@riverside-rec.example' },
    kind: 'reminder_only',
    event: { title: 'Swim lessons', startsAt: STARTS_AT.toISOString() },
    eventId: null,
    teen: async () => false,
    now: NOW,
    ...over,
  };
}

describe("captureEmailBringItems — an email in the parent's own inbox", () => {
  const BODY = 'Please bring a swimsuit, towel and goggles.';

  function ports(read: BringItemsRead, body: () => Promise<string> = async () => BODY) {
    const script = scripted(read);
    const readBody = vi.fn(body);
    const port: EmailBringPorts = { readBody, readBringItems: script.reader };
    return { port, readBody, inputs: script.inputs };
  }

  it('flag off: reads nothing and keeps nothing', async () => {
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    const { port, readBody, inputs } = ports({ status: 'read', items: ['towel'], dropped: 0 });
    const teen = vi.fn(async () => false);
    expect(
      await captureEmailBringItems(
        db.database,
        emailInput({ eventId: await seedEvent(), teen }),
        port,
      ),
    ).toEqual({ status: 'off' });
    expect(readBody).not.toHaveBeenCalled();
    expect(teen).not.toHaveBeenCalled();
    expect(inputs).toEqual([]);
    expect(await bringRows()).toEqual([]);
  });

  it('an email about an event the family holds keeps its list against that event', async () => {
    const eventId = await seedEvent();
    const { port, inputs } = ports({
      status: 'read',
      items: ['a swimsuit', 'towel', 'goggles'],
      dropped: 0,
    });
    expect(await captureEmailBringItems(db.database, emailInput({ eventId }), port)).toEqual({
      status: 'recorded',
      count: 3,
      onEvent: true,
    });
    expect(inputs[0]).toEqual({
      event: { title: 'Swim lessons', startsAt: STARTS_AT.toISOString() },
      source: {
        kind: 'email',
        from: 'swim@riverside-rec.example',
        subject: 'Swim starts Saturday',
        body: BODY,
      },
    });
    const [row] = await bringRows();
    expect(row).toMatchObject({
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'gmail-msg-1'),
      items: ['a swimsuit', 'towel', 'goggles'],
    });
  });

  it("a 13+ child's mail is never read for a list", async () => {
    const { port, readBody } = ports({ status: 'read', items: ['cleats'], dropped: 0 });
    expect(
      await captureEmailBringItems(db.database, emailInput({ teen: async () => true }), port),
    ).toEqual({ status: 'skipped', reason: 'teen' });
    expect(readBody).not.toHaveBeenCalled();
  });

  it('a teen check that cannot answer fails closed', async () => {
    const { port, readBody } = ports({ status: 'read', items: ['cleats'], dropped: 0 });
    expect(
      await captureEmailBringItems(
        db.database,
        emailInput({
          teen: async () => {
            throw new Error('children unread');
          },
        }),
        port,
      ),
    ).toEqual({ status: 'skipped', reason: 'teen' });
    expect(readBody).not.toHaveBeenCalled();
  });

  it('a cancellation is not read for a list', async () => {
    const { port, readBody } = ports({ status: 'read', items: ['towel'], dropped: 0 });
    expect(
      await captureEmailBringItems(db.database, emailInput({ kind: 'cancellation' }), port),
    ).toEqual({ status: 'skipped', reason: 'kind' });
    expect(readBody).not.toHaveBeenCalled();
  });

  it('no reader is not_configured, named', async () => {
    expect(
      await captureEmailBringItems(db.database, emailInput(), { readBody: async () => BODY }),
    ).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('a source already read is not read twice', async () => {
    const eventId = await seedEvent();
    const first = ports({ status: 'read', items: ['towel'], dropped: 0 });
    await captureEmailBringItems(db.database, emailInput({ eventId }), first.port);
    const second = ports({ status: 'read', items: ['towel'], dropped: 0 });
    expect(await captureEmailBringItems(db.database, emailInput({ eventId }), second.port)).toEqual(
      { status: 'skipped', reason: 'already_read' },
    );
    expect(second.readBody).not.toHaveBeenCalled();
  });

  it('a reading with nothing in it keeps nothing; a body that will not load is failed', async () => {
    const none = ports({ status: 'none', dropped: 0 });
    expect(await captureEmailBringItems(db.database, emailInput(), none.port)).toEqual({
      status: 'none',
    });
    const broken = ports({ status: 'read', items: ['towel'], dropped: 0 }, async () => {
      throw new Error('gmail messages.get 500');
    });
    expect(
      await captureEmailBringItems(db.database, emailInput({ messageId: 'other' }), broken.port),
    ).toEqual({ status: 'failed', stage: 'body' });
    const unavailable = ports({ status: 'unavailable', cause: 'no_key' });
    expect(
      await captureEmailBringItems(
        db.database,
        emailInput({ messageId: 'third' }),
        unavailable.port,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(await bringRows()).toEqual([]);
  });
});

const IMAGE_BLOCK: Anthropic.ContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};

function photoInput(over: Partial<CoachBringInput> = {}): CoachBringInput {
  return {
    familyId,
    parentUserId,
    channelMessageId: randomUUID(),
    parentWords: 'can she do this one?',
    event: { title: 'Little Movers Dance', startsAt: STARTS_AT.toISOString() },
    media: [{ kind: 'image', url: 'https://media.linq.example/flyer.png', mime: 'image/png' }],
    audience: 'direct',
    now: NOW,
    ...over,
  };
}

describe('captureCoachOfferBringItems — a flyer the parent sent 1:1', () => {
  function photoPorts(read: BringItemsRead) {
    const script = scripted(read);
    const readImages = vi.fn(async () => [IMAGE_BLOCK]);
    return {
      port: { readImages, readBringItems: script.reader },
      readImages,
      inputs: script.inputs,
    };
  }

  it('flag off: reads nothing', async () => {
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    const { port, readImages } = photoPorts({ status: 'read', items: ['dance shoes'], dropped: 0 });
    expect(await captureCoachOfferBringItems(db.database, photoInput(), port)).toEqual({
      status: 'off',
    });
    expect(readImages).not.toHaveBeenCalled();
  });

  it('a group turn, a turn with no image and a missing port are each named', async () => {
    const { port, readImages } = photoPorts({ status: 'read', items: ['dance shoes'], dropped: 0 });
    expect(
      await captureCoachOfferBringItems(db.database, photoInput({ audience: 'group' }), port),
    ).toEqual({ status: 'skipped', reason: 'group' });
    expect(
      await captureCoachOfferBringItems(
        db.database,
        photoInput({
          media: [
            { kind: 'file', url: 'https://media.linq.example/a.pdf', mime: 'application/pdf' },
          ],
        }),
        port,
      ),
    ).toEqual({ status: 'skipped', reason: 'no_image' });
    expect(await captureCoachOfferBringItems(db.database, photoInput(), undefined)).toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
    expect(readImages).not.toHaveBeenCalled();
  });

  it('keeps the list pending under the coach offer this answer carried', async () => {
    const { port, inputs } = photoPorts({
      status: 'read',
      items: ['dance shoes', 'a water bottle'],
      dropped: 0,
    });
    const input = photoInput();
    expect(await captureCoachOfferBringItems(db.database, input, port)).toEqual({
      status: 'recorded',
      count: 2,
    });
    expect(inputs[0]?.source).toEqual({
      kind: 'photo',
      parentWords: 'can she do this one?',
      attachments: [IMAGE_BLOCK],
    });
    const [row] = await bringRows();
    expect(row).toMatchObject({
      ownerUserId: parentUserId,
      eventId: null,
      sourceKind: 'photo',
      sourceRef: bringSourceRef(COACH_CALENDAR_INTEGRATION_ID, `coach:${input.channelMessageId}`),
    });
  });
});

describe("the parent's yes attaches a pending list to the event it places", () => {
  it('an email offer: the list read from that email joins the placed event', async () => {
    const channelMessageId = await sentOut();
    await recordEmailAlertOffer(db.database, {
      familyId,
      parentUserId,
      integrationId: INTEGRATION,
      messageId: 'offer-msg',
      channelMessageId,
      draft: { kind: 'new_event', title: 'Field trip', startsAt: STARTS_AT, location: null },
      now: NOW,
    });
    const { reader } = scripted({
      status: 'read',
      items: ['a packed lunch', 'a signed permission slip'],
      dropped: 0,
    });
    await captureEmailBringItems(
      db.database,
      emailInput({ messageId: 'offer-msg', kind: 'new_event' }),
      {
        readBody: async () => 'Pack a packed lunch and a signed permission slip.',
        readBringItems: reader,
      },
    );
    const [offer] = await loadOpenEmailAlertOffers(db.database, {
      familyId,
      parentUserId,
      now: NOW,
    });
    if (!offer) throw new Error('no open offer');
    await handleEmailAlertOfferReply(db.database, {
      familyId,
      parentUserId,
      offerId: offer.id,
      polarity: 'yes',
      parentReply: 'yes please',
      now: NOW,
    });
    const [placed] = await db.database
      .select({ id: schema.familyEvents.id })
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, familyId));
    if (!placed) throw new Error('no placed event');
    const lists = await loadBringItemsFor(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventIds: [placed.id],
    });
    expect(lists.get(placed.id)).toEqual(['a packed lunch', 'a signed permission slip']);
  });

  it('a coach offer on a flyer: the flyer list joins the placed event', async () => {
    const channelMessageId = await sentOut();
    expect(
      await recordCoachCalendarOffer(db.database, {
        familyId,
        parentUserId,
        channelMessageId,
        title: 'Little Movers Dance',
        startsAt: STARTS_AT,
        location: null,
        now: NOW,
      }),
    ).toBe('recorded');
    const { reader } = scripted({ status: 'read', items: ['dance shoes'], dropped: 0 });
    await captureCoachOfferBringItems(db.database, photoInput({ channelMessageId }), {
      readImages: async () => [IMAGE_BLOCK],
      readBringItems: reader,
    });
    const [offer] = await loadOpenEmailAlertOffers(db.database, {
      familyId,
      parentUserId,
      now: NOW,
    });
    if (!offer) throw new Error('no open offer');
    await handleEmailAlertOfferReply(db.database, {
      familyId,
      parentUserId,
      offerId: offer.id,
      polarity: 'yes',
      parentReply: 'yes',
      now: NOW,
    });
    const [row] = await bringRows();
    expect(row?.eventId).not.toBeNull();
    expect(row?.items).toEqual(['dance shoes']);
  });

  it('with the flag off at the yes, nothing is attached (the list stays pending)', async () => {
    const channelMessageId = await sentOut();
    await recordEmailAlertOffer(db.database, {
      familyId,
      parentUserId,
      integrationId: INTEGRATION,
      messageId: 'offer-off',
      channelMessageId,
      draft: { kind: 'new_event', title: 'Field trip', startsAt: STARTS_AT, location: null },
      now: NOW,
    });
    const { reader } = scripted({ status: 'read', items: ['a packed lunch'], dropped: 0 });
    await captureEmailBringItems(
      db.database,
      emailInput({ messageId: 'offer-off', kind: 'new_event' }),
      { readBody: async () => 'Pack a packed lunch.', readBringItems: reader },
    );
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    const [offer] = await loadOpenEmailAlertOffers(db.database, {
      familyId,
      parentUserId,
      now: NOW,
    });
    if (!offer) throw new Error('no open offer');
    await handleEmailAlertOfferReply(db.database, {
      familyId,
      parentUserId,
      offerId: offer.id,
      polarity: 'yes',
      parentReply: 'yes',
      now: NOW,
    });
    const [row] = await bringRows();
    expect(row?.eventId).toBeNull();
  });
});
