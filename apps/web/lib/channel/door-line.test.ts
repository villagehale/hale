import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as friendVoice from '~/lib/channel/intake/friend-voice';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import { DOOR_LINE_PURPOSES, composeDoorLine, joinDoorModelCopyEnabled } from './door-line';
import { type SpokenLineRequest, setSharedSpokenLineWriter } from './spoken-line';

const SKILL = readFileSync(join(process.cwd(), '../../packages/agent/skills/door-line.md'), 'utf8');

afterEach(() => {
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('joinDoorModelCopyEnabled', () => {
  it('is on only for the exact value true', () => {
    expect(joinDoorModelCopyEnabled({})).toBe(false);
    expect(joinDoorModelCopyEnabled({ JOIN_DOOR_MODEL_COPY_ENABLED: 'true' })).toBe(true);
    for (const value of ['true\n', ' true', 'true ', 'TRUE', 'True', '1', 'on', 'yes', '']) {
      expect(joinDoorModelCopyEnabled({ JOIN_DOOR_MODEL_COPY_ENABLED: value })).toBe(false);
    }
  });
});

describe('composeDoorLine', () => {
  function recording(answer: string | null) {
    const calls: SpokenLineRequest[] = [];
    setSharedSpokenLineWriter({
      async write(request) {
        calls.push(request);
        return answer;
      },
    });
    return calls;
  }

  it('lit: asks the writer with the door-line addendum and returns its line', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    const calls = recording('Ana added you.');
    const line = await composeDoorLine({
      purpose: 'join_welcome',
      language: 'en',
      facts: { inviterName: 'Ana' },
    });
    expect(line).toEqual({ sent: true, body: 'Ana added you.' });
    expect(calls).toEqual([
      {
        purpose: 'join_welcome',
        language: 'en',
        facts: { inviterName: 'Ana' },
        addendum: 'door-line',
      },
    ]);
  });

  it('lit: a writer that wrote nothing is a held line, named unwritten', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recording(null);
    expect(await composeDoorLine({ purpose: 'caregiver_welcome', language: 'en' })).toEqual({
      sent: false,
      held: 'unwritten',
    });
  });

  it('dark: never asks the writer, and names the hold flag_off', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const calls = recording('should not send');
    expect(await composeDoorLine({ purpose: 'join_accepted_ack', language: 'en' })).toEqual({
      sent: false,
      held: 'flag_off',
    });
    expect(calls).toEqual([]);
  });
});

describe('every door purpose', () => {
  it.each(DOOR_LINE_PURPOSES)('%s is said in the door-line skill', (purpose) => {
    expect(SKILL).toContain(`\`${purpose}\``);
  });

  it('each has an eval fixture in the join-door suite', async () => {
    // The eval cannot reach `~/`, so it keeps its own fixtures; this keeps them complete.
    const path = '../../../worker/evals/join-door-fixtures.mjs';
    const { JOIN_DOOR_FIXTURES } = (await import(/* @vite-ignore */ path)) as {
      JOIN_DOOR_FIXTURES: Array<{ request: { purpose: string } }>;
    };
    const covered = new Set(JOIN_DOOR_FIXTURES.map((f) => f.request.purpose));
    expect(DOOR_LINE_PURPOSES.filter((p) => !covered.has(p))).toEqual([]);
  });

  it('the skill tells the model never to name an opt-out keyword', () => {
    expect(SKILL).toContain('Never name STOP, HELP, ARRET, AIDE, or any other word to reply with');
  });

  it('the skill takes the link as a slot and its lifetime as a fact, and states neither', () => {
    expect(SKILL).toContain('`[[link]]`');
    expect(SKILL).toContain('`facts.validForDays`');
    expect(SKILL).not.toMatch(/\b7 days\b/);
  });

  it('the eval scores a door line with the judge checks that read the text alone', async () => {
    const path = '../../../worker/evals/join-door-fixtures.mjs';
    const { doorLineMisses } = (await import(/* @vite-ignore */ path)) as {
      doorLineMisses: (body: string, voice: typeof friendVoice) => string[];
    };
    expect(doorLineMisses("You're registered for swim at 4.", friendVoice)).toEqual([
      'friend_voice:registration_claim',
    ]);
    expect(
      doorLineMisses(
        'All booked, your spot is locked in and your data is never shared.',
        friendVoice,
      ),
    ).toEqual(['friend_voice:registration_claim']);
    expect(doorLineMisses('I never read your work email.', friendVoice)).toEqual([
      'friend_voice:privacy',
    ]);
    expect(doorLineMisses('Reply with the number you want.', friendVoice)).toEqual([
      'friend_voice:banned',
    ]);
    expect(doorLineMisses('Text STOP to leave.', friendVoice)).toEqual(['friend_voice:compliance']);
    expect(
      doorLineMisses(
        "You're in - I'll text you the week's schedule and pickup reminders, and nothing else.",
        friendVoice,
      ),
    ).toEqual([]);
  });
});
