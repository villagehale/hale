import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TurnPhotoFacts } from '~/lib/channel/inbound-photo-facts';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import type { ChannelTurn } from '~/lib/channel/router/coach-runtime';
import { POLICY_VERSION } from '~/lib/consent';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';
import { createTurnOfferLedger } from './tools';

/**
 * The registration URL a photo's facts hand to the coach's tools, through the PRODUCTION
 * buildTools. A photo's URL may seed only offer_signup, which asks the parent and names
 * the host before anything runs. It never seeds a watch: list_watch_targets and
 * watch_for_opening take a URL the parent typed (or a tool returned) this turn. A PDF's
 * text layer can hold words the parent never saw, so its URL counts only when the parent
 * typed that whole URL — never a URL the parent's text merely starts with.
 */

const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-08T15:00:00.000Z');
const PAGE = 'https://harbor-rec.example/register';
/** A course page on a portal in the spot registry: invented ids. */
const COURSE =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=55555555-6666-7777-8888-999999999999';

function facts(readFrom: TurnPhotoFacts['readFrom'], registrationUrl = PAGE): TurnPhotoFacts {
  return {
    kind: 'flyer',
    title: 'Fall swim',
    venue: 'Harbor Rec',
    whenText: 'Tuesdays 4:30',
    registrationUrl,
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
  vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
  vi.stubEnv('F14_ENABLED', 'true');
  // No reply model: an offer that clears every guard stops at the writer as `unwritten`.
  vi.stubEnv('VOICE_DISABLED', 'true');
  // A watch that clears every guard reaches the portal fetch, which this stub refuses.
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(String(url));
    throw new Error('photo-facts-links.pglite.test: this test makes no network calls');
  });
  const family = await seedFamily(db.database);
  await seedChild(db.database, family.familyId, 'Ada', 72, undefined, NOW);
  await db.database.insert(schema.consentRecords).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    consentType: 'proactive_watch',
    granted: true,
    consentScope: WATCH_CONSENT_SCOPE,
    policyVersion: POLICY_VERSION,
    evidence: { verbatimReply: 'yes please' },
  });
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
  const ports = productionChannelCoachPorts(db.database);
  const tools = ports.buildTools(
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
    fetched,
    offer: (registrationUrl = PAGE) =>
      invokeTool(
        pick('offer_signup'),
        {
          child: 'Ada',
          source: 'flyer',
          registrationUrl,
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
    watchForOpening: (url: string) =>
      invokeTool(pick('watch_for_opening'), { url, label: 'Fall swim' }, ctx, ports.guardDeps).then(
        () => 'armed',
        (err: Error) => err.message,
      ),
  };
}

describe('photo facts as links seen this turn — production wiring', () => {
  it('a photo: its URL may seed the signup ask, and nothing a watch reads', async () => {
    const tools = await toolsFor('can you sign Ada up for this?', facts('image'));
    await expect(tools.offer()).resolves.toEqual({ recorded: false, reason: 'unwritten' });
    await expect(tools.canWatch()).resolves.toEqual([]);
  });

  it('a photo of a full course page: watch_for_opening refuses it before reading the portal', async () => {
    const tools = await toolsFor('can you watch this for a spot?', facts('image', COURSE));
    await expect(tools.watchForOpening(COURSE)).resolves.toMatch(/did not send that link/);
    expect(tools.fetched).toEqual([]);
  });

  it('the same course page typed by the parent reaches the portal read', async () => {
    // Positive control for the refusal above: the guard refuses the photo's URL, not
    // every URL.
    const tools = await toolsFor(
      `can you watch this for a spot? ${COURSE}`,
      facts('image', COURSE),
    );
    await expect(tools.watchForOpening(COURSE)).resolves.toMatch(/could not reach/);
    expect(tools.fetched).toHaveLength(1);
  });

  it('a PDF only: its URL is refused by the offer and not watchable', async () => {
    const tools = await toolsFor('can you sign Ada up for this?', facts('document'));
    await expect(tools.offer()).resolves.toEqual({
      recorded: false,
      reason: 'url_not_this_turn',
    });
    await expect(tools.canWatch()).resolves.toEqual([]);
  });

  it('a PDF whose URL the parent typed only as part of a longer one: refused', async () => {
    const tools = await toolsFor(`sign Ada up, it's ${PAGE}-fall-2026`, facts('document'));
    await expect(tools.offer()).resolves.toEqual({
      recorded: false,
      reason: 'url_not_this_turn',
    });
    await expect(tools.canWatch()).resolves.toEqual([]);
  });

  it('a PDF whose URL the parent also typed: allowed', async () => {
    const tools = await toolsFor(`sign Ada up, it's ${PAGE}.`, facts('document'));
    await expect(tools.offer()).resolves.toEqual({ recorded: false, reason: 'unwritten' });
    await expect(tools.canWatch()).resolves.toEqual(['link:0']);
  });
});
