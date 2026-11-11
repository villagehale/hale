import { invokeTool } from '@hale/agent';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TurnPhotoFacts } from '~/lib/channel/inbound-photo-facts';
import type { ChannelTurn } from '~/lib/channel/router/coach-runtime';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';
import { createTurnOfferLedger } from './tools';

/**
 * The registration URL a photo's facts hand to offer_signup and the provider watch, through
 * the PRODUCTION buildTools. A photo is what the parent is looking at, so its URL counts as
 * seen this turn. A PDF's text layer can hold words the parent never saw, so its URL counts
 * only when the parent typed that URL too.
 */

const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-08T15:00:00.000Z');
const PAGE = 'https://harbor-rec.example/register';

function facts(readFrom: TurnPhotoFacts['readFrom']): TurnPhotoFacts {
  return {
    kind: 'flyer',
    title: 'Fall swim',
    venue: 'Harbor Rec',
    whenText: 'Tuesdays 4:30',
    registrationUrl: PAGE,
    childName: null,
    notes: null,
    confidence: 0.9,
    readFrom,
  };
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function toolsFor(body: string, photoFacts: TurnPhotoFacts) {
  vi.stubEnv('ANTHROPIC_API_KEY', 'not-used-by-this-test');
  vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
  vi.stubEnv('BROWSER_USE_WATCH_ENABLED', 'true');
  // No reply model: an offer that clears every guard stops at the writer as `unwritten`.
  vi.stubEnv('VOICE_DISABLED', 'true');
  vi.stubGlobal('fetch', async () => {
    throw new Error('photo-facts-links.pglite.test: this test makes no network calls');
  });
  const family = await seedFamily(db.database);
  await seedChild(db.database, family.familyId, 'Ada', 72, undefined, NOW);
  const turn: ChannelTurn = {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    conversationId: CONVERSATION_ID,
    body,
    now: NOW,
    standingQuestions: [],
    audience: 'direct',
    photoFacts,
  };
  const noop = () => {};
  const tools = productionChannelCoachPorts(db.database).buildTools(
    turn,
    noop,
    noop,
    noop,
    noop,
    noop,
    createTurnOfferLedger(),
    undefined,
    undefined,
    'CA',
  );
  const pick = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`production buildTools registers no ${name}`);
    return tool;
  };
  const ctx = { familyId: family.familyId, actor: family.parentUserId };
  const deps = { writeAudit: async () => {} };
  return {
    offer: () =>
      invokeTool(
        pick('offer_signup'),
        {
          child: 'Ada',
          source: 'flyer',
          registrationUrl: PAGE,
          evidence: 'Fall swim, Tuesdays 4:30 at Harbor Rec',
          sessions: [
            {
              id: 'tue-1630',
              label: 'Tue 4:30',
              startsAt: '2026-11-10T21:30:00.000Z',
              endsAt: '2026-11-10T22:15:00.000Z',
              full: false,
              priceCents: null,
            },
          ],
          approvedPriceCents: null,
        },
        ctx,
        deps,
      ),
    canWatch: async () =>
      (
        (await invokeTool(pick('list_watch_targets'), {}, ctx, deps)) as {
          canWatch: { sourceRef: string }[];
        }
      ).canWatch.map((c) => c.sourceRef),
  };
}

describe('photo facts as links seen this turn — production wiring', () => {
  it('a photo: its URL clears the offer guard and is watchable', async () => {
    const tools = await toolsFor('can you sign Ada up for this?', facts('image'));
    await expect(tools.offer()).resolves.toEqual({ recorded: false, reason: 'unwritten' });
    await expect(tools.canWatch()).resolves.toEqual(['link:0']);
  });

  it('a PDF only: its URL is refused by the offer and not watchable', async () => {
    const tools = await toolsFor('can you sign Ada up for this?', facts('document'));
    await expect(tools.offer()).resolves.toEqual({
      recorded: false,
      reason: 'url_not_this_turn',
    });
    await expect(tools.canWatch()).resolves.toEqual([]);
  });

  it('a PDF whose URL the parent also typed: allowed', async () => {
    const tools = await toolsFor(`sign Ada up, it's ${PAGE}`, facts('document'));
    await expect(tools.offer()).resolves.toEqual({ recorded: false, reason: 'unwritten' });
    await expect(tools.canWatch()).resolves.toEqual(['link:0']);
  });
});
