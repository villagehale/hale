import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const forcedState = vi.hoisted(() => ({ done: null as unknown }));

// The form's `done` state is only reachable through a browser submit. Every state that
// starts null gets the forced value; `done` is read first, so the others go unused.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) =>
      initial === null && forcedState.done !== null
        ? [forcedState.done, () => {}]
        : react.useState(initial),
  };
});

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
const CHECKBOX_OFF =
  "Text me a reminder the day before. One message from Hale about this party only — reply STOP any time. Your number isn't stored unless you tick this.";
const CHECKBOX_ON =
  "Text me a reminder the day before. One message from Hale about this party only. To end it, reply and ask Hale to stop texting you. Your number isn't stored unless you tick this.";
const CONFIRMATION_OFF = "I'll text you once, the day before. Reply STOP any time.";
const CONFIRMATION_ON =
  "I'll text you once, the day before. To end it, reply and ask Hale to stop texting you.";

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pageText(): Promise<string> {
  const element = await RsvpPage({ params: Promise.resolve({ token: 'token' }) });
  return visibleText(renderToStaticMarkup(element));
}

async function confirmationPageText(): Promise<string> {
  forcedState.done = { answer: 'yes', reminderOptIn: true };
  return pageText();
}

describe('the reminder wording on the RSVP page', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    forcedState.done = null;
  });

  it('flag exactly true: the page shows the new checkbox line and no keyword', async () => {
    vi.stubEnv(FLAG, 'true');
    const page = await pageText();
    expect(page).toContain(CHECKBOX_ON);
    expect(page).not.toContain(CHECKBOX_OFF);
    expect(page).not.toMatch(/\bSTOP\b/);
    expect(page).not.toMatch(/\bHELP\b/);
  });

  it.each([undefined, 'false', 'True', 'true\n', '1'])(
    "flag %j: the page keeps today's checkbox line",
    async (value) => {
      vi.stubEnv(FLAG, value as string);
      const page = await pageText();
      expect(page).toContain(CHECKBOX_OFF);
      expect(page).not.toContain(CHECKBOX_ON);
    },
  );

  it('flag exactly true: the real confirmation screen shows the new line and no keyword', async () => {
    vi.stubEnv(FLAG, 'true');
    const page = await confirmationPageText();
    expect(page).toContain(CONFIRMATION_ON);
    expect(page).not.toContain(CONFIRMATION_OFF);
    expect(page).not.toMatch(/\bSTOP\b/);
    expect(page).not.toMatch(/\bHELP\b/);
  });

  it.each([undefined, 'false', 'True', 'true\n', '1'])(
    "flag %j: the real confirmation screen keeps today's line",
    async (value) => {
      vi.stubEnv(FLAG, value as string);
      const page = await confirmationPageText();
      expect(page).toContain(CONFIRMATION_OFF);
      expect(page).not.toContain(CONFIRMATION_ON);
    },
  );
});
