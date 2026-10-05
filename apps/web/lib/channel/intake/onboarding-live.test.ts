import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKidItemClassifier } from '~/lib/channel/connect/aha-kids';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { createFriendVoiceComposer } from './friend-voice';
import { LIVE_FROM, runOnboardingReplay } from './onboarding-live-harness';

/**
 * The live replay of the founder's iMessage test (VIL-417): real model, real
 * intake machine, real connect receipts, Postgres in-process. Gated, because
 * it calls Anthropic. Run it with
 *
 *   cd apps/web && LIVE=1 HALE_LLM_NO_STREAM=1 ANTHROPIC_API_KEY=... \
 *     pnpm exec vitest run lib/channel/intake/onboarding-live.test.ts
 *
 * or `pnpm --filter @hale/web live:onboarding`. Every outbound bubble is
 * printed verbatim, then the rule checks (onboarding-live-rules.ts) and the
 * p50 turn latency. The mechanics of the walk are covered without a key in
 * onboarding-live-harness.test.ts.
 */

const LIVE = process.env.LIVE === '1' && Boolean(process.env.ANTHROPIC_API_KEY);
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe.skipIf(!LIVE)('live onboarding replay (real model)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LIVE_FROM);
    vi.stubEnv('HALE_LLM_NO_STREAM', process.env.HALE_LLM_NO_STREAM ?? '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/typing') || target.includes('share_contact_card')) {
          return new Response(null, { status: 204 });
        }
        if (target.includes('/contact_card')) {
          if ((init?.method ?? 'GET') === 'GET') {
            return Response.json({
              contact_cards: [
                { phone_number: LIVE_FROM, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
              ],
            });
          }
          return Response.json({
            phone_number: LIVE_FROM,
            first_name: HALE_CONTACT_FIRST_NAME,
            is_active: true,
          });
        }
        return new Response(null, { status: 204 });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.close();
  });

  it(
    'walks the founder script and keeps every rule',
    async () => {
      const client = budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      const report = await runOnboardingReplay(db.database, {
        friendVoice: createFriendVoiceComposer(client),
        kidItems: createKidItemClassifier(client),
        print: (line) => process.stdout.write(`${line}\n`),
      });
      expect(report.violations).toEqual([]);
    },
    10 * 60_000,
  );
});
