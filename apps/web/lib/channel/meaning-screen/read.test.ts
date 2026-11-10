import { afterEach, describe, expect, it } from 'vitest';
import {
  MEANING_SCREEN_MAX_TOKENS,
  MEANING_SCREEN_SKILL,
  MEANING_SCREEN_TOOL,
  createMeaningScreen,
  meaningScreenUserMessage,
  setSharedMeaningScreen,
  sharedMeaningScreen,
} from './read';
import { blankMeaningReading, unreadMeaningScreen } from './scripted-reader.fixture';

afterEach(() => {
  setSharedMeaningScreen(unreadMeaningScreen);
});

describe('meaningScreenUserMessage', () => {
  it('sends the screen name and the text, and drops a long body', () => {
    const payload = JSON.parse(
      meaningScreenUserMessage({ screen: 'stated_state', text: 'Yes we booked already' }),
    ) as { screen: string; text: string };
    expect(payload).toEqual({ screen: 'stated_state', text: 'Yes we booked already' });
    const long = 'x'.repeat(2000);
    const cut = JSON.parse(
      meaningScreenUserMessage({ screen: 'stated_state', text: long }),
    ) as { text: string };
    expect(cut.text.length).toBe(1600);
  });

  it('includes allowed facts only when they were handed in', () => {
    expect(JSON.parse(meaningScreenUserMessage({ screen: 'copy_friend', text: 'Hi' }))).toEqual({
      screen: 'copy_friend',
      text: 'Hi',
    });
    expect(
      JSON.parse(
        meaningScreenUserMessage({
          screen: 'copy_friend',
          text: 'Hi',
          facts: ['Mia swim'],
        }),
      ),
    ).toEqual({ screen: 'copy_friend', text: 'Hi', facts: ['Mia swim'] });
  });
});

describe('createMeaningScreen fail-closed', () => {
  it('returns null when the client cannot be built', async () => {
    const screen = createMeaningScreen(() => {
      throw new Error('no key');
    });
    expect(await screen.read({ screen: 'stated_state', text: 'we booked already' })).toBeNull();
  });

  it('returns null when forceToolJson throws', async () => {
    const screen = createMeaningScreen(
      () =>
        ({
          messages: {
            create: async () => {
              throw new Error('outage');
            },
          },
        }) as never,
    );
    expect(await screen.read({ screen: 'stated_state', text: 'we booked already' })).toBeNull();
  });
});

describe('sharedMeaningScreen', () => {
  it('uses the injected reader', async () => {
    setSharedMeaningScreen({
      read: async () => blankMeaningReading({ hit: true }),
    });
    const reading = await sharedMeaningScreen().read({
      screen: 'stated_state',
      text: 'Yes we booked already',
    });
    expect(reading?.hit).toBe(true);
  });

  it('an unread injection is a miss', async () => {
    setSharedMeaningScreen(unreadMeaningScreen);
    expect(
      await sharedMeaningScreen().read({ screen: 'stated_state', text: 'Yes we booked already' }),
    ).toBeNull();
  });
});

describe('constants the eval pins', () => {
  it('keeps the skill name, tool, and token cap', () => {
    expect(MEANING_SCREEN_SKILL).toBe('meaning-screen');
    expect(MEANING_SCREEN_TOOL).toBe('meaning_screen');
    expect(MEANING_SCREEN_MAX_TOKENS).toBe(256);
  });
});
