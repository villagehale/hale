import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertProactiveSendAllowed } from '~/lib/channel/outbound-gate';
import { answerParentDutyAsk, defaultDutySendPorts, emailDutyInGroup, sweepDutyAsks } from './asks';
import { COPARENT_DUTY_SENDS_ENABLED_ENV } from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('duty ask flag off', () => {
  it('does not read or send when the flag is off', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, '');
    const database = new Proxy(
      {},
      {
        get() {
          throw new Error('flag off must not touch the database');
        },
      },
    ) as Database;
    await expect(sweepDutyAsks(database)).resolves.toMatchObject({ enabled: false, sent: 0 });
    const extract = vi.fn(() => {
      throw new Error('llm');
    });
    await expect(
      answerParentDutyAsk(database, {
        familyId: 'fam',
        actorUserId: 'user',
        text: "who's got pickup Thursday?",
        now: new Date(),
        extract,
      }),
    ).resolves.toEqual({ skipped: 'flag_off' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('treats TRUE and a trailing newline as off', async () => {
    const database = {
      select: () => {
        throw new Error('read');
      },
    } as unknown as Database;
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'TRUE');
    await expect(sweepDutyAsks(database)).resolves.toMatchObject({ enabled: false });
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true\n');
    await expect(sweepDutyAsks(database)).resolves.toMatchObject({ enabled: false });
  });
});

describe('duty ask transport', () => {
  it('uses the outbound gate and does not import a 1:1, SMS, email, or push sender', () => {
    expect(defaultDutySendPorts().gate).toBe(assertProactiveSendAllowed);
    const source = readFileSync(fileURLToPath(new URL('./asks.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('createTwilioTransport');
    expect(source).not.toContain('gmail');
    expect(source).not.toContain('sendEmail');
    expect(source).not.toContain('web-push');
    expect(source).not.toContain('nodemailer');
    expect(emailDutyInGroup()).toEqual({ suppressed: 'mail_not_in_group' });
  });
});
