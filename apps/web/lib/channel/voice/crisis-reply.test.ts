import { afterEach, describe, expect, it, vi } from 'vitest';
import { crisisFactsForRegion } from '~/lib/channel/crisis-resources';
import type { SaidLineInput, SaidLineWriter } from './said-line';
import {
  CRISIS_VIOLATION_FACT,
  EMERGENCY_SITUATION_FACT,
  acceptSaidLine,
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
    expect(calls[0]?.facts).toEqual({ ...crisisFactsForRegion('CA', 'mental') });
    expect(calls[0]).not.toHaveProperty('parentWords');
    expect(calls[0]).not.toHaveProperty('recentParentWords');
    expect(error).not.toHaveBeenCalled();
  });

  it('an emergency is written from 911-only facts and what the reader read, with no digits in it', async () => {
    const { writer, calls } = scriptedWriter('Call 911 now.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: 'US',
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call 911 now.', attempts: 1 });
    expect(calls[0]?.purpose).toBe('crisis_emergency');
    expect(calls[0]?.facts).toEqual({ emergency: '911', situation: EMERGENCY_SITUATION_FACT });
    expect(EMERGENCY_SITUATION_FACT).not.toMatch(/\p{Nd}/u);
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
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call or text 988, any time.', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.facts).not.toHaveProperty('previousTextNotSent');
    expect(calls[1]?.facts).toEqual({
      ...crisisFactsForRegion('US', 'mental'),
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
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call 911 now.', attempts: 2 });
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.emergency_988);
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

  it('a writer that returns nothing sends nothing and pages', async () => {
    const { writer, calls } = scriptedWriter(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      where: 'intake crisis',
      writer,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'write_failed' });
    expect(calls).toHaveLength(1);
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
