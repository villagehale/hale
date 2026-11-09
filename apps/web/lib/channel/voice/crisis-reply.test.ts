import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRISIS_SITUATIONS,
  CRISIS_WHO,
  crisisFactsForRegion,
} from '~/lib/channel/crisis-resources';
import type {
  CrisisPageOutcome,
  CrisisPager,
  CrisisUnanswered,
  SaidLineInput,
  SaidLineWriter,
} from './said-line';
import {
  CRISIS_VIOLATION_FACT,
  EMERGENCY_FIRST_STEP_FACTS,
  acceptSaidLine,
  crisisLineInput,
  deliverCrisisReply,
  emergencySituationFact,
} from './said-line';

const INBOUND = 'provider-inbound-crisis-1';
const FAMILY = '00000000-0000-4000-8000-00000000c559';
const PARENT = '00000000-0000-4000-8000-00000000a559';

/** The pager port, recorded: every alert it was handed, answering `outcome` or throwing
 * it, and the order the record and the page were asked for. */
function recordingPager(outcome: CrisisPageOutcome | Error = 'paged'): {
  pager: CrisisPager;
  alerts: CrisisUnanswered[];
  recorded: CrisisUnanswered[];
  steps: Array<'record' | 'page'>;
} {
  const alerts: CrisisUnanswered[] = [];
  const recorded: CrisisUnanswered[] = [];
  const steps: Array<'record' | 'page'> = [];
  return {
    alerts,
    recorded,
    steps,
    pager: {
      async record(alert) {
        steps.push('record');
        recorded.push(alert);
      },
      async page(alert) {
        steps.push('page');
        alerts.push(alert);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  };
}

/** The inbound this crisis arrived on, whose it was, and the pager that hears about a miss. */
function onTurn(pager: CrisisPager = recordingPager().pager) {
  return { inboundId: INBOUND, familyId: FAMILY, parentUserId: PARENT, pager };
}

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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
    expect(crisisLineInput('emergency', 'CA', 'ar', null, null).facts.replyLanguage).toBe(
      'العربية',
    );
    expect(crisisLineInput('mental', 'CA', 'zh', null, null).facts.replyLanguage).toBe('中文');
    expect(crisisLineInput('mental', 'CA', 'hi', null, null).facts.replyLanguage).toBe('हिन्दी');
    expect(crisisLineInput('mental', 'CA', null, null, null).facts).not.toHaveProperty(
      'replyLanguage',
    );
    expect(crisisLineInput('mental', 'CA', 'xx', null, null).facts).not.toHaveProperty(
      'replyLanguage',
    );
  });

  it('an emergency is written from 911-only facts and what the reader read, with no digits in it', async () => {
    const { writer, calls } = scriptedWriter('Call 911 now.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: 'US',
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(),
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call 911 now.', attempts: 1 });
    expect(calls[0]?.purpose).toBe('crisis_emergency');
    expect(calls[0]?.facts).toEqual({
      emergency: '911',
      situation: emergencySituationFact('other', 'unknown'),
      firstStep: EMERGENCY_FIRST_STEP_FACTS.other,
    });
  });

  it('an emergency carries what the reader read happening, as a closed fact with no digits or links', async () => {
    const { writer, calls } = scriptedWriter('Appelle le 911 maintenant.');
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: 'fr',
      region: 'CA',
      situation: 'poisoning_or_overdose',
      who: null,
      where: 'intake crisis',
      ...onTurn(),
      writer,
    });
    expect(outcome.status).toBe('sent');
    expect(calls[0]?.facts).toEqual({
      emergency: '911',
      situation: emergencySituationFact('poisoning_or_overdose', 'unknown'),
      firstStep: EMERGENCY_FIRST_STEP_FACTS.poisoning_or_overdose,
      replyLanguage: 'français',
    });
    expect(calls[0]).not.toHaveProperty('parentWords');
    const texts = CRISIS_SITUATIONS.flatMap((situation) =>
      CRISIS_WHO.map((who) => emergencySituationFact(situation, who)),
    );
    expect(new Set(texts).size).toBe(CRISIS_SITUATIONS.length * CRISIS_WHO.length);
    for (const text of texts) {
      expect(text).not.toMatch(/\p{Nd}/u);
      expect(text).not.toMatch(/:\/\/|www\.|\.[a-z]{2,}\b/i);
    }
    // Positive control: the pattern above does catch a digit.
    expect('call 911').toMatch(/\p{Nd}/u);
  });

  it('the person in danger is the reader\'s closed who, never a bare "someone"', async () => {
    const { writer, calls } = scriptedWriter('请马上拨打911。');
    await deliverCrisisReply({
      kind: 'emergency',
      language: 'zh',
      region: 'CA',
      situation: 'unresponsive',
      who: 'child',
      where: 'intake crisis',
      ...onTurn(),
      writer,
    });
    expect(calls[0]?.facts.situation).toBe(emergencySituationFact('unresponsive', 'child'));
    const named: Record<(typeof CRISIS_WHO)[number], string> = {
      child: 'their child',
      adult: 'an adult',
      self: 'the parent who is texting',
      unknown: 'Hale was not told who',
    };
    for (const situation of CRISIS_SITUATIONS) {
      for (const who of CRISIS_WHO) {
        const fact = emergencySituationFact(situation, who);
        expect(fact).toContain(named[who]);
        expect(fact).not.toMatch(/\bsomeone\b/i);
        // Every other who's wording is absent, so the fact names one person only.
        for (const other of CRISIS_WHO.filter((w) => w !== who)) {
          expect(fact).not.toContain(named[other]);
        }
      }
    }
    // Positive control: the absence check above does catch the old wording.
    expect('they just told Hale someone is choking right now').toMatch(/\bsomeone\b/i);
  });

  it('every situation has one code-owned first step: dispatcher-led, no other number, no link', () => {
    expect(Object.keys(EMERGENCY_FIRST_STEP_FACTS).sort()).toEqual([...CRISIS_SITUATIONS].sort());
    for (const situation of CRISIS_SITUATIONS) {
      const step = EMERGENCY_FIRST_STEP_FACTS[situation];
      expect(step).toContain('911');
      expect(step).toContain('dispatcher');
      expect(step.replaceAll('911', '')).not.toMatch(/\p{Nd}/u);
      expect(step).not.toMatch(/:\/\/|www\.|\.[a-z]{2,}\b/i);
    }
    expect(EMERGENCY_FIRST_STEP_FACTS.not_breathing).toContain('CPR');
    expect(EMERGENCY_FIRST_STEP_FACTS.unresponsive).toContain('CPR');
    // Positive control: the digit check sees a number other than 911.
    expect('call 911 or 555 0100'.replaceAll('911', '')).toMatch(/\p{Nd}/u);
  });

  it('the re-ask keeps who, the situation and the first step, and adds only the reason', async () => {
    const { writer, calls } = scriptedWriter('Call 911, or text 988.', 'Call 911 now.');
    await deliverCrisisReply({
      kind: 'emergency',
      language: 'en',
      region: 'US',
      situation: 'choking',
      who: 'child',
      where: 'intake crisis',
      ...onTurn(),
      writer,
    });
    expect(calls[1]?.facts).toEqual({
      emergency: '911',
      situation: emergencySituationFact('choking', 'child'),
      firstStep: EMERGENCY_FIRST_STEP_FACTS.choking,
      replyLanguage: 'English',
      previousTextNotSent: CRISIS_VIOLATION_FACT.emergency_988,
    });
  });

  it('a mental-health request is unchanged by the situation and who: its facts are the lines', () => {
    expect(crisisLineInput('mental', 'US', 'en', 'self_harm', 'self').facts).toEqual({
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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
    const { pager, alerts } = recordingPager();
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'link', page: 'paged' });
    expect(calls).toHaveLength(2);
    // The real pager is told once, with what happened and where — never what was drafted.
    expect(alerts).toEqual([
      {
        kind: 'mental',
        where: 'intake crisis',
        reason: 'link',
        writes: 2,
        inboundId: INBOUND,
        familyId: FAMILY,
        parentUserId: PARENT,
        language: null,
        situation: null,
        who: null,
      },
    ]);
    const handed = JSON.stringify(alerts);
    expect(handed).not.toContain('example');
    expect(handed).not.toContain('988');
    // The re-ask told the writer the first draft carried a link.
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.link);
    // The urgent log is the pager's (failure-page.ts); a page that went out adds none here.
    expect(error).not.toHaveBeenCalled();
  });

  it('a write that returns nothing is re-asked once, the same as a failed check', async () => {
    const { writer, calls } = scriptedWriter(null, 'Call or text 988, any time.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'en',
      region: 'US',
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(),
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
      who: null,
      where: 'intake crisis',
      ...onTurn(),
      writer,
    });
    expect(outcome).toEqual({ status: 'sent', body: 'Call or text 988.', attempts: 2 });
    expect(calls[1]?.facts.previousTextNotSent).toBe(CRISIS_VIOLATION_FACT.write_failed);
  });

  it('a writer that returns nothing twice sends nothing and pages once', async () => {
    const { writer, calls } = scriptedWriter(null, null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts } = recordingPager();
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'write_failed', page: 'paged' });
    expect(calls).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ reason: 'write_failed', writes: 2 });
    expect(error).not.toHaveBeenCalled();
  });

  it('no writer wired is named and paged, never silent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts } = recordingPager();
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer: null,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer', page: 'paged' });
    expect(alerts).toEqual([
      {
        kind: 'emergency',
        where: 'intake crisis',
        reason: 'no_writer',
        writes: 0,
        inboundId: INBOUND,
        familyId: FAMILY,
        parentUserId: PARENT,
        language: null,
        situation: null,
        who: null,
      },
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('the alert check sees a word the alert does carry (positive control for the absences above)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts } = recordingPager();
    await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis example 988',
      ...onTurn(pager),
      writer: null,
    });
    const handed = JSON.stringify(alerts);
    expect(handed).toContain('example');
    expect(handed).toContain('988');
  });

  it('the record is written before the page, so a pager that throws still leaves it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, recorded, steps } = recordingPager(new Error('slack down'));
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer: null,
    });
    expect(outcome).toMatchObject({ status: 'unanswered', page: 'page_failed' });
    expect(steps).toEqual(['record', 'page']);
    expect(recorded).toEqual([
      {
        kind: 'mental',
        where: 'intake crisis',
        reason: 'no_writer',
        writes: 0,
        inboundId: INBOUND,
        familyId: FAMILY,
        parentUserId: PARENT,
        language: null,
        situation: null,
        who: null,
      },
    ]);
  });

  it('a record that throws is logged and the page still goes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts } = recordingPager();
    pager.record = async () => {
      throw new Error('ledger down');
    };
    const outcome = await deliverCrisisReply({
      kind: 'emergency',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer: null,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer', page: 'paged' });
    expect(alerts).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'emergency', reason: 'no_writer', err: 'Error' }),
      'crisis record did not land - the page is its only trace',
    );
  });

  it('a pager that throws is named page_failed, and that failure is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts } = recordingPager(new Error('slack down'));
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer: null,
    });
    expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer', page: 'page_failed' });
    expect(alerts).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mental', page: 'page_failed' }),
      'crisis page did not go out',
    );
  });

  it('an inbound with no provider id gets one fresh id, shared by its record and page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, alerts, recorded } = recordingPager();
    const ask = (inboundId: string) =>
      deliverCrisisReply({
        kind: 'mental',
        language: null,
        region: null,
        situation: null,
        who: null,
        where: 'intake crisis',
        ...onTurn(pager),
        inboundId,
        writer: null,
      });
    await ask('');
    await ask('  ');
    expect(alerts.map((alert) => alert.inboundId)).toEqual(
      recorded.map((alert) => alert.inboundId),
    );
    expect(alerts[0]?.inboundId).toMatch(/^missing-[0-9a-f-]{36}$/);
    expect(alerts[1]?.inboundId).toMatch(/^missing-[0-9a-f-]{36}$/);
    expect(alerts[0]?.inboundId).not.toBe(alerts[1]?.inboundId);
    // Positive control: a real id is passed through as is.
    await ask(INBOUND);
    expect(alerts[2]?.inboundId).toBe(INBOUND);
  });

  it('a page that could not leave is carried as is, never as paged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const answered of ['page_failed', 'page_not_configured', 'already_paged'] as const) {
      const outcome = await deliverCrisisReply({
        kind: 'emergency',
        language: null,
        region: null,
        situation: null,
        who: null,
        where: 'intake crisis',
        ...onTurn(recordingPager(answered).pager),
        writer: null,
      });
      expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer', page: answered });
    }
  });

  it('a reply that went out pages nobody (positive control for every page above)', async () => {
    const { writer } = scriptedWriter(null, 'Call or text 988, any time.');
    const { pager, alerts } = recordingPager();
    const outcome = await deliverCrisisReply({
      kind: 'mental',
      language: 'en',
      region: 'US',
      situation: null,
      who: null,
      where: 'intake crisis',
      ...onTurn(pager),
      writer,
    });
    expect(outcome.status).toBe('sent');
    expect(alerts).toEqual([]);
  });
});
