import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/party/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/party/store')>()),
  loadPublicParty: async () => ({
    title: 'Party',
    location: null,
    startsAt: new Date('2026-11-21T19:00:00.000Z'),
    timeZone: 'America/Toronto',
    cancelled: false,
    teenFirstNames: [],
  }),
}));

const { default: RsvpPage } = await import('./page');

const FLAG = 'RSVP_GUEST_PLAIN_STOP_ENABLED';

async function pageText(): Promise<string> {
  const element = await RsvpPage({ params: Promise.resolve({ token: 'token' }) });
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'");
}

describe('VIL-742 the server hands the flag to the RSVP form', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exactly true: the form renders the plain wording', async () => {
    vi.stubEnv(FLAG, 'true');
    const page = await pageText();
    expect(page).toContain("If you'd rather not hear from Hale, reply and say so.");
    expect(page).not.toMatch(/\bSTOP\b/i);
    expect(page).not.toMatch(/\bHELP\b/i);
  });

  it.each([undefined, 'false', 'True', 'true\n'])(
    '%j: the form keeps the wording of today',
    async (value) => {
      vi.stubEnv(FLAG, value as string);
      const page = await pageText();
      expect(page).toContain('reply STOP any time');
      expect(page).not.toContain('rather not hear from Hale');
    },
  );
});
