import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFollowupVoice } from '~/lib/channel/followup/voice';
import { fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { type SpokenLineInput, speakLine } from '~/lib/channel/voice/spoken-line';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { OPS_PAGE_WINDOW_HOURS, claimOpsPage } from './ops-page-claim';

/**
 * One #ops page per key per day, through the real unique index. A family whose line
 * fails on every cron tick pages once, and pages again tomorrow.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const NOON = new Date('2026-07-06T12:00:00.000Z');

describe('claimOpsPage', () => {
  it('is true once per key per window, and true again in the next window', async () => {
    expect(await claimOpsPage(db.database, 'spoken-line:a:b:fam-1', NOON)).toBe(true);
    expect(await claimOpsPage(db.database, 'spoken-line:a:b:fam-1', NOON)).toBe(false);
    const later = new Date(NOON.getTime() + 3_600_000);
    expect(await claimOpsPage(db.database, 'spoken-line:a:b:fam-1', later)).toBe(false);
    expect(await claimOpsPage(db.database, 'spoken-line:a:b:fam-2', later)).toBe(true);
    const tomorrow = new Date(NOON.getTime() + OPS_PAGE_WINDOW_HOURS * 3_600_000);
    expect(await claimOpsPage(db.database, 'spoken-line:a:b:fam-1', tomorrow)).toBe(true);
  });

  it('pages anyway when the store is a bare stand-in (a page lost is the worse failure)', async () => {
    expect(await claimOpsPage({} as Database, 'k', NOON)).toBe(true);
    expect(await claimOpsPage({} as Database, 'k', NOON)).toBe(true);
  });
});

describe('speakLine with a scope', () => {
  const input: SpokenLineInput = {
    skill: 'group-voice',
    kind: 'kid_event',
    language: 'en',
    address: 'vous',
    facts: { kid: 'Maya' },
    questions: 0,
  };

  it('pages #ops once per family, skill and kind per day, and logs the rest', async () => {
    const page = vi.fn(async (_text: string) => undefined);
    const voice = fakeSpokenLineComposer({ fail: true });
    for (let tick = 0; tick < 3; tick++) {
      const result = await speakLine(voice, input, {
        page,
        scope: { familyId: 'fam-page-1', database: db.database },
      });
      expect(result.source).toBe('unsent');
    }
    expect(page).toHaveBeenCalledTimes(1);

    // A different family is a different page.
    await speakLine(voice, input, {
      page,
      scope: { familyId: 'fam-page-2', database: db.database },
    });
    expect(page).toHaveBeenCalledTimes(2);

    // A different kind for the first family is a different page too.
    await speakLine(
      voice,
      { ...input, kind: 'handoff' },
      { page, scope: { familyId: 'fam-page-1', database: db.database } },
    );
    expect(page).toHaveBeenCalledTimes(3);
  });

  it('pages every miss when no scope is given', async () => {
    const page = vi.fn(async (_text: string) => undefined);
    const voice = fakeSpokenLineComposer({ fail: true });
    await speakLine(voice, input, { page });
    await speakLine(voice, input, { page });
    expect(page).toHaveBeenCalledTimes(2);
  });
});

describe('createFollowupVoice with a scope', () => {
  const noClient = (): AgentClient => {
    throw new Error('ANTHROPIC_API_KEY is not set');
  };

  it('pages #ops once per family and kind per day across hourly deferrals', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = vi.fn(async (_text: string) => undefined);
    const voice = createFollowupVoice(noClient, { page });
    const scope = { familyId: 'fam-followup-1', database: db.database };
    for (let tick = 0; tick < 3; tick++) {
      const outcome = await voice.compose({ kind: 'intro' }, scope);
      expect(outcome).toEqual({ status: 'deferred', reason: 'client_unavailable' });
    }
    expect(page).toHaveBeenCalledTimes(1);

    await voice.compose({ kind: 'activity', activity: 'Swim' }, scope);
    expect(page).toHaveBeenCalledTimes(2);

    await voice.compose({ kind: 'intro' }, { ...scope, familyId: 'fam-followup-2' });
    expect(page).toHaveBeenCalledTimes(3);

    await voice.compose({ kind: 'intro' });
    expect(page).toHaveBeenCalledTimes(4);
    quiet.mockRestore();
  });
});
