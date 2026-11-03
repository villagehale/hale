import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRISIS_SITUATIONS, crisisFactsForRegion } from '~/lib/channel/crisis-resources';
import type { SaidLineInput, SaidLineWriter } from './said-line';
import {
  CRISIS_VIOLATION_FACT,
  EMERGENCY_SITUATION_FACTS,
  acceptSaidLine,
  crisisLineInput,
  deliverCrisisReply,
} from './said-line';

const PAGE = 'URGENT: crisis flagged, no reply sent - page #ops now';

/** The writer port, scripted: one reply per call, in order. Records every request. */
function scriptedWriter(...replies: Array<string | null>): {
  writer: SaidLineWriter;
  calls: SaidLineInput[];
} {
  const calls: SaidLineInput[] = [];
  return {
    calls,
    writer: {
      async write(input) {
        calls.push(input);
        return replies[calls.length - 1] ?? null;
      },
    },
  };
}

describe('deliverCrisisReply · facts-only writer, one check, one re-ask', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes from facts only: no parent words, the region line, the given language', async () => {
    const { writer, calls } = scriptedWriter('Appelle ou texte le 988, à toute heure.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'fr',
      region: 'CA',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({
      status: 'sent',
      body: 'Appelle ou texte le 988, à toute heure.',
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('crisis_mental');
    expect(calls[0]?.language).toBe('fr');
    expect(calls[0]?.facts).toEqual({
      ...crisisFactsForRegion('CA', 'mental'),
      replyLanguage: 'français',
    });
    expect(calls[0]).not.toHaveProperty('parentWords');
    expect(calls[0]).not.toHaveProperty('recentParentWords');
    expect(error).not.toHaveBeenCalled();
  });

  it('names the reply language in its own script, so that script is in front of the writer', () => {
    // Probe 11-03: with only the tag 'ar', 6 of 6 writer draws came back as mojibake;
    // with the Arabic name of the language as a fact, 3 of 3 were Arabic.
    expect(crisisLineInput('emergency', 'CA', 'ar', null).facts.replyLanguage).toBe('العربية');
    expect(crisisLineInput('mental', 'CA', 'zh', null).facts.replyLanguage).toBe('中文');
    expect(crisisLineInput('mental', 'CA', 'hi', null).facts.replyLanguage).toBe('हिन्दी');
    expect(crisisLineInput('mental', 'CA', null, null).facts).not.toHaveProperty('replyLanguage');
    expect(crisisLineInput('mental', 'CA', 'xx', null).facts).not.toHaveProperty('replyLanguage');
  });

  it('an emergency is written from 911-only facts and what the reader read, with no digits in it', async () => {
    const { writer, calls } = scriptedWriter('Call 911 now.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: 'US',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call 911 now.', attempts: 1 });
    expect(calls[0]?.purpose).toBe('crisis_emergency');
    expect(calls[0]?.facts).toEqual({
      emergency: '911',
      situation: EMERGENCY_SITUATION_FACTS.other,
    });
  });

  it('an emergency carries what the reader read happening, as a closed fact with no digits or links', async () => {
    const { writer, calls } = scriptedWriter('Appelle le 911 maintenant.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: 'fr',
      region: 'CA',
      situation: 'poisoning_or_overdose',
      where: 'intake crisis',
      writer,
    });
    expect(outcome.status).toBe('sent');
    expect(calls[0]?.facts).toEqual({
      emergency: '911',
      situation: EMERGENCY_SITUATION_FACTS.poisoning_or_overdose,
      replyLanguage: 'français',
    });
    expect(calls[0]).not.toHaveProperty('parentWords');
    const texts = CRISIS_SITUATIONS.map((situation) => EMERGENCY_SITUATION_FACTS[situation]);
    expect(new Set(texts).size).toBe(CRISIS_SITUATIONS.length);
    for (const text of texts) {
      expect(text).not.toMatch(/\p{Nd}/u);
      expect(text).not.toMatch(/:\/\/|www\.|\.[a-z]{2,}\b/i);
    }
    // Positive control: the pattern above does catch a digit.
    expect('call 911').toMatch(/\p{Nd}/u);
  });

  it('a mental-health request is unchanged by the situation: its facts are the lines', () => {
    expect(crisisLineInput('mental', 'US', 'en', 'self_harm').facts).toEqual({
      ...crisisFactsForRegion('US', 'mental'),
      replyLanguage: 'English',
    });
  });

  it('a 9-8-8 reply passes the said-line structural check too: the line is checked once, by the crisis check', async () => {
    const reply = 'Appelle ou texte le 9-8-8.';
    const calls: SaidLineInput[] = [];
    const writer: SaidLineWriter = {
      async write(input) {
        calls.push(input);
        return acceptSaidLine(reply, input);
      },
    };
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'fr',
      region: 'CA',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: reply, attempts: 1 });
    // Positive control: the same structural check refuses it when 988 is required verbatim.
    expect(
      acceptSaidLine(reply, { ...calls[0], mustInclude: ['988'] } as SaidLineInput),
    ).toBeNull();
  });

  it('re-asks once with the violation named as a fact, and sends the second reply when it passes', async () => {
    const { writer, calls } = scriptedWriter(
      'Call or text 988, or the clinic on 555 0100.',
      'Call or text 988, any time.',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'en',
      region: 'US',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call or text 988, any time.', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.facts).not.toHaveProperty('previousTextNotSent');
    expect(calls[1]?.facts).toEqual({
      ...crisisFactsForRegion('US', 'mental'),
      replyLanguage: 'English',
      previousTextNotSent: CRISIS_VIOLATION_FACT.other_number,
    });
    expect(calls[1]).not.toHaveProperty('parentWords');
    expect(error).not.toHaveBeenCalled();
  });

  it('an emergency reply that carries 988 is re-asked with emergency_988 named', async () => {
    const { writer, calls } = scriptedWriter('Call 911, or text 988.', 'Call 911 now.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: 'CA',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call 911 now.', attempts: 2 });
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.emergency_988);
  });

  it('a reply with no letter of the reply language is re-asked with wrong_script named', async () => {
    const { writer, calls } = scriptedWriter('Ш§ШЄШµЩ„ Ш§Щ„Ш¢Щ† 911.', 'اتصل بـ 911 الآن.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: 'ar',
      region: 'CA',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'اتصل بـ 911 الآن.', attempts: 2 });
    expect(calls[1]?.language).toBe('ar');
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.wrong_script);
  });

  it('two failed checks send nothing, page #ops once and name the last violation', async () => {
    const { writer, calls } = scriptedWriter(
      'Call or text 988 or see example.org',
      'Call or text 988 or see example[.]org',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'link' });
    expect(calls).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        urgent: true,
        kind: 'mental',
        where: 'intake crisis',
        reason: 'link',
      }),
      PAGE,
    );
  });

  it('a write that returns nothing is re-asked once, the same as a failed check', async () => {
    const { writer, calls } = scriptedWriter(null, 'Call or text 988, any time.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'en',
      region: 'US',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call or text 988, any time.', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.write_failed);
    expect(error).not.toHaveBeenCalled();
  });

  it('a draft the said-line structural check refuses (a typed URL) is re-asked, not dropped', async () => {
    const drafts = ['Call or text 988, or chat at https://example.org/chat', 'Call or text 988.'];
    const calls: SaidLineInput[] = [];
    const writer: SaidLineWriter = {
      async write(input) {
        calls.push(input);
        return acceptSaidLine(drafts[calls.length - 1] ?? '', input);
      },
    };
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'en',
      region: 'US',
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call or text 988.', attempts: 2 });
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.write_failed);
  });

  it('a writer that returns nothing twice sends nothing and pages once', async () => {
    const { writer, calls } = scriptedWriter(null, null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'write_failed' });
    expect(calls).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'mental', reason: 'write_failed' }),
      PAGE,
    );
  });

  it('no writer wired is named and paged, never silent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: null,
      situation: null,
      where: 'intake crisis',
      writer: null,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer' });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'emergency', reason: 'no_writer' }),
      PAGE,
    );
  });
});
