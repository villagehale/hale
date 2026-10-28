import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as linq from './linq/transport';

/**
 * VIL-466 · On a Preview capture run, every outbound door is either the capture
 * transport or refused before any network call. Traced doors:
 *
 *   - phone 1:1 (router replies, reminders, nudges, follow-ups, check-ins, sweeps,
 *     calendar invites via productionChannels → createSmsChannel) all go through
 *     createOutboundTransport, which returns the capture transport (see
 *     preview-capture-transport.test.ts);
 *   - every direct Linq partner call (groups, tapbacks, polls, contact cards,
 *     connect-link 1:1) goes through linqRequest in linq/transport.ts, which
 *     refuses `preview_capture` first (behaviour checked below for every export);
 *   - the worker executor's drains (apps/web/lib/cron/drain.ts): send_email is the
 *     only external send port, wired to createGmailEmailSender, which refuses during
 *     capture (preview-capture-refusals.test.ts). Calendar writes use
 *     sendUpdates=none, so Google mails no one, and invites ride productionChannels.
 *
 * The structural half fails loudly if a new file reaches a send host directly.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const SCAN_ROOTS = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages'];

/** Hosts or endpoints that put words in front of a person. */
const SEND_ENDPOINTS = [
  'api.linqapp.com',
  'api.twilio.com',
  'gmail/v1/users/me/messages/send',
  'api.resend.com',
  'api.sendgrid.com',
  'api.postmarkapp.com',
  'api.mailgun.net',
  '/sendMail',
] as const;

/** The only files allowed to hold a send endpoint, each with its capture gate. */
const SEND_ENDPOINT_FILES: Record<string, string> = {
  'apps/web/lib/channel/linq/transport.ts':
    'linqRequest throws preview_capture before any fetch while PREVIEW_CAPTURE_TRANSPORT=on',
  'apps/worker/src/services/gmail-send.ts':
    'imported only by gmail-send-service.ts, whose sender refuses during a capture run',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'evals' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(path);
  }
  return out;
}

const FILES = SCAN_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root))).map((path) => ({
  rel: relative(REPO_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('every outbound door is captured or refused on a Preview capture run', () => {
  it('only the gated modules hold a send endpoint', () => {
    const offenders = FILES.filter(
      (f) => SEND_ENDPOINTS.some((e) => f.text.includes(e)) && !(f.rel in SEND_ENDPOINT_FILES),
    ).map((f) => f.rel);
    expect(offenders, 'new send endpoint: route it through a capture-gated door').toEqual([]);
  });

  it('the Linq module fetches in exactly one place: linqRequest, behind the capture gate', () => {
    const text = FILES.find((f) => f.rel === 'apps/web/lib/channel/linq/transport.ts')?.text ?? '';
    expect(text.match(/(?<![\w.])fetch\(/g) ?? []).toEqual([]);
    expect(text.match(/doFetch\(/g) ?? []).toHaveLength(1);
    const gate = text.indexOf(
      "if (previewCaptureRequested()) throw new LinqSendError('preview_capture'",
    );
    expect(gate).toBeGreaterThan(text.indexOf('async function linqRequest('));
    expect(gate).toBeLessThan(text.indexOf('doFetch('));
  });

  it('the parent-Gmail send is reached only through the capture-gated sender', () => {
    const importers = FILES.filter(
      (f) =>
        f.text.includes('@hale/worker/gmail-send') || /from '\.\/gmail-send(\.js)?'/.test(f.text),
    ).map((f) => f.rel);
    expect(importers).toEqual(['apps/web/lib/integrations/gmail-send-service.ts']);
    const service = FILES.find((f) => f.rel === importers[0])?.text ?? '';
    expect(service).toContain('previewCapture: () => previewCaptureRequested()');
  });

  it('the worker drain wires its send ports only to gated doors', () => {
    const drain = FILES.find((f) => f.rel === 'apps/web/lib/cron/drain.ts')?.text ?? '';
    expect(drain).toContain('const sendEmail = createGmailEmailSender(db())');
    expect(drain).toContain('productionChannels(db())');
    const phone = FILES.find((f) => f.rel === 'apps/web/lib/channel/adapters/phone-sms.ts')?.text;
    expect(phone).toContain('deps.transport ?? createOutboundTransport()');
  });

  it('every exported Linq network call refuses before fetch, even with a key set', async () => {
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'configured');
    vi.stubEnv('LINQ_FROM_E164', '+14375550000');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchSpy);
    const PURE = /^(read|linqMessageKey|contactCardIsLive)/;
    const calls = Object.entries(linq).filter(
      ([name, value]) =>
        typeof value === 'function' &&
        /Linq/.test(name) &&
        !PURE.test(name) &&
        !/^(LinqSendError|createLinqPhoneTransport)$/.test(name),
    );
    expect(calls.length).toBeGreaterThan(15);
    const input = {
      chatId: 'c',
      messageId: 'm',
      from: '+14375550000',
      to: ['+14375550001'],
      handle: '+14375550001',
      phoneNumber: '+14375550000',
      text: 'x',
      parts: [{ type: 'text', value: 'x' }],
      question: 'q',
      options: ['a', 'b'],
      type: 'love',
      effect: 'slam',
      fetch: fetchSpy,
    };
    for (const [, fn] of calls) {
      try {
        await (fn as (a: unknown, b: unknown) => unknown)(input, fetchSpy);
      } catch {
        // refusals are the point; only a fetch would be a failure
      }
    }
    const phone = linq.createLinqPhoneTransport({ fetch: fetchSpy as unknown as typeof fetch });
    await expect(phone.send({ to: '+14375550001', body: 'x' })).rejects.toMatchObject({
      code: 'preview_capture',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
