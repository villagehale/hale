import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConsentAsk,
  acceptConsentAsk,
  consentAskKeywordless,
  createConsentAskWriter,
  instructsConsentKeyword,
  writeConsentAsk,
} from './consent-ask';

describe('instructsConsentKeyword', () => {
  it('rejects a token instruction and allows the carrier opt-out', () => {
    expect(instructsConsentKeyword('Reply YES today')).toBe(true);
    expect(instructsConsentKeyword('Text INTROS back')).toBe(true);
    expect(instructsConsentKeyword('Repondez NON')).toBe(true);
    expect(instructsConsentKeyword('Reply STOP anytime')).toBe(false);
    expect(instructsConsentKeyword('Repondez ARRET')).toBe(false);
    expect(instructsConsentKeyword('Want me to send your note?')).toBe(false);
  });
});

describe('acceptConsentAsk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a keyword instruction and keeps a long draft in another script', () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const long = `${'Want me to keep this change? '.repeat(20)}`;
    expect(acceptConsentAsk('Reply YES today.')).toBeNull();
    expect(acceptConsentAsk('帮我问问他们')).toBe('帮我问问他们');
    expect(acceptConsentAsk(long)).toBe(long);
    expect(acceptConsentAsk('Want me to send your note?')).toBe('Want me to send your note?');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('over_segment_cap');
  });
});

describe('createConsentAskWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a missing client and sends nothing', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const writer = createConsentAskWriter(() => {
      throw new Error('no key');
    });
    await expect(writer.write({ kind: 'founder_retry' })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
  });
});

describe('writeConsentAsk', () => {
  it('names a missing writer', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      writeConsentAsk(undefined, { kind: 'founder_ping', location: 'Georgetown' }),
    ).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('not_configured');
    logged.mockRestore();
  });
});

describe('VIL-706 · the door asks, lit, name no opt-out keyword', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const STRANGER: ConsentAsk[] = [
    { kind: 'caregiver_invite', who: 'Ana', role: 'nanny' },
    { kind: 'caregiver_nudge' },
    { kind: 'coparent_invite', inviterName: 'Ana', language: 'fr' },
    { kind: 'coparent_nudge', language: 'en' },
  ];

  it('is keywordless only for the four stranger kinds, and only with the door flag lit', () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    for (const ask of STRANGER) expect(consentAskKeywordless(ask), ask.kind).toBe(false);
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    for (const ask of STRANGER) expect(consentAskKeywordless(ask), ask.kind).toBe(true);
    expect(consentAskKeywordless({ kind: 'caregiver_scope', name: 'Ana', role: 'nanny' })).toBe(
      false,
    );
    expect(consentAskKeywordless({ kind: 'founder_retry' })).toBe(false);
  });

  it('refuses a keywordless draft that names a keyword, and keeps the dark acceptance', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const strict = { refuseOptOutKeyword: true };
    expect(acceptConsentAsk('Ana added you. Text STOP anytime.', strict)).toBeNull();
    expect(acceptConsentAsk('Ana vous a ajouté. Répondez ARRET en tout temps.', strict)).toBeNull();
    const plain = "Ana added you as their nanny. If you'd rather not hear from me, just say so.";
    expect(acceptConsentAsk(plain, strict)).toBe(plain);
    // Dark, the carrier opt-out is still allowed on a first text, as before.
    expect(acceptConsentAsk('Ana added you. Text STOP anytime.')).toBe(
      'Ana added you. Text STOP anytime.',
    );
  });

  /**
   * A client that records the request and then fails, as a down provider would. Request
   * mechanics only: no model output is stood in for.
   */
  function recordingDownClient(seen: unknown[]) {
    return (): AgentClient =>
      ({
        messages: {
          create: async (params: { system?: unknown }) => {
            seen.push(params.system);
            throw new Error('provider down');
          },
        },
      }) as unknown as AgentClient;
  }

  const systemText = (system: unknown) =>
    (system as Array<{ text: string }>).map((block) => block.text).join('');

  /**
   * The client port handing back one fixed draft, so the writer's own acceptance runs on
   * it. The model's wording is not what is under test; the refusal wired behind it is.
   */
  function draftClient(text: string) {
    return (): AgentClient =>
      ({
        messages: {
          create: async () => ({
            // Both shapes, so the stub does not depend on which the lane's request uses.
            content: [
              { type: 'text', text: JSON.stringify({ text }) },
              { type: 'tool_use', id: 'draft', name: 'consent_ask', input: { text } },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }) as unknown as AgentClient;
  }

  it('lit: the writer refuses a stranger draft that names a keyword, and logs why', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const writer = createConsentAskWriter(draftClient('Ana added you. Reply STOP anytime.'));
    await expect(writer.write(STRANGER[0] as ConsentAsk)).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('names_opt_out_keyword');
  });

  it('lit: the writer passes a plain-words stranger draft (positive control)', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const plain = "Ana added you as their nanny. If you'd rather not hear from me, just say so.";
    const writer = createConsentAskWriter(draftClient(plain));
    await expect(writer.write(STRANGER[0] as ConsentAsk)).resolves.toBe(plain);
  });

  it('dark: the same keyword draft to a stranger keeps its acceptance', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const draft = 'Ana added you. Reply STOP anytime.';
    const writer = createConsentAskWriter(draftClient(draft));
    await expect(writer.write(STRANGER[0] as ConsentAsk)).resolves.toBe(draft);
  });

  it('lit, a stranger kind carries the no-keyword addendum after the skill', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: unknown[] = [];
    await createConsentAskWriter(recordingDownClient(seen)).write(STRANGER[0] as ConsentAsk);
    expect(systemText(seen[0])).toContain('# How to stop, in their own words');
  });

  it('dark, and lit on any other kind, the request keeps its bytes', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: unknown[] = [];
    await createConsentAskWriter(recordingDownClient(seen)).write(STRANGER[0] as ConsentAsk);
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
    await createConsentAskWriter(recordingDownClient(seen)).write({ kind: 'founder_retry' });
    expect(seen).toHaveLength(2);
    for (const system of seen) {
      expect(systemText(system)).not.toContain('# How to stop, in their own words');
    }
  });
});
