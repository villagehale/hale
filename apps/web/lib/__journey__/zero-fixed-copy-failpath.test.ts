import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeDutyWrite } from '~/lib/channel/coparent/duty/ack';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from '~/lib/channel/coparent/duty/flag';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { sendWelcomeContactCard } from '~/lib/channel/intake/welcome-card';
import { linqGroupOpenLine, linqGroupUnreachableLine } from '~/lib/channel/linq/group';
import { recMorningReply, writeRecMorningIntakeReply } from '~/lib/channel/rec-morning';
import { replyProse } from '~/lib/channel/reply-copy/apply';
import { recMorningHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

/**
 * #973 · absolute zero fixed copy — the FAIL-PATH proof. A fake family, a capture
 * transport and a model that writes nothing. Every parent-facing path these tickets
 * touched must send nothing at all: no canned line stands in for the model.
 */

const FAMILY = '00000000-0000-4000-8000-0000000009f1';
const PARENT = '00000000-0000-4000-8000-0000000009a1';
const SILENT_MODEL = { write: async () => null };

afterEach(() => {
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function quiet() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
}

describe('#973 fail-path: model writes nothing → nothing is sent', () => {
  it('VIL-505 contact card: no_line, no MMS, no thread, key unspent', async () => {
    quiet();
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const threaded: unknown[] = [];
    const outcome = await sendWelcomeContactCard(
      fake.db,
      { familyId: FAMILY, parentUserId: PARENT, phoneE164: '+14375550101', now: new Date() },
      {
        transport,
        threadMessage: async (_db, input) => {
          threaded.push(input);
          return 'c';
        },
        saidLine: SILENT_MODEL,
      },
    );
    expect(outcome).toEqual({ status: 'not_sent', reason: 'no_line' });
    expect(transport.sent).toEqual([]);
    expect(threaded).toEqual([]);
  });

  it('VIL-506 group open / cannot-open: both lines are null, never a constant', async () => {
    setSharedSpokenLineWriter(SILENT_MODEL);
    for (const language of ['en', 'fr', null] as const) {
      expect(await linqGroupOpenLine(language)).toBeNull();
      expect(await linqGroupUnreachableLine(language)).toBeNull();
    }
  });

  it('VIL-507 duty: no model client → replyProse null; a model miss sends no restate', async () => {
    quiet();
    const db = {} as Database;
    expect(
      await replyProse(
        {
          client: null,
          database: db,
          familyId: FAMILY,
          language: 'fr',
          audience: 'group',
          surface: 'duty',
        },
        { purpose: 'duty_owner', questionAllowed: false, facts: ['Sam', 'Maya', 'natation'] },
      ),
    ).toBeNull();

    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    // An explicit null client is "no model" (resolveReplyClient). Nothing is
    // scripted onto messages.create: a miss sends no restate.
    const ack = await acknowledgeDutyWrite({
      database: db,
      familyId: FAMILY,
      actorUserId: PARENT,
      source: 'llm',
      now: new Date('2026-09-24T15:00:00.000Z'),
      timeZone: 'America/Toronto',
      inboundChatId: 'chat-1',
      inboundMessageId: 'm-1',
      language: 'fr',
      name: 'Sam',
      kid: 'Maya',
      event: 'swim',
      day: 'samedi',
      time: '15:00',
      replyClient: null,
    });
    expect(ack).toMatchObject({ sent: false, status: 'skipped', reason: 'model_unsent' });
  });

  it('VIL-508 rec-morning: facts exist, model silent → router leaves it to the coach, intake falls through', async () => {
    quiet();
    setSharedSpokenLineWriter(SILENT_MODEL);
    const body = 'is efun still a thing?';
    expect(recMorningReply(body, new Date())).not.toBeNull();
    const verdict = await recMorningHandler().handle(
      {} as Database,
      {
        body,
        now: new Date(),
        familyId: FAMILY,
      } as unknown as HandlerContext,
    );
    expect(verdict).toEqual({ claimed: false });
    expect(await writeRecMorningIntakeReply({ parentWords: body, pendingAsk: '' })).toBeNull();
  });
});
