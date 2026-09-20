import { describe, expect, it } from 'vitest';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';
import { FAQ, faqJsonLd } from './index';

describe('product FAQ', () => {
  it('every item has a non-empty question and answer', () => {
    expect(FAQ.length).toBeGreaterThan(0);
    for (const item of FAQ) {
      expect(item.question.trim().length).toBeGreaterThan(0);
      expect(item.answer.trim().length).toBeGreaterThan(0);
    }
  });

  it('faqJsonLd is a FAQPage with one Question per item', () => {
    const ld = faqJsonLd();
    expect(ld['@type']).toBe('FAQPage');
    const entities = ld.mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(FAQ.length);
    for (const q of entities) {
      expect(q['@type']).toBe('Question');
      expect((q.acceptedAnswer as { '@type': string })['@type']).toBe('Answer');
    }
  });
});

describe('the FAQ this build serves', () => {
  it('describes a number you text rather than an app you sign up for', () => {
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).toContain('text');
    expect(answers).toContain('no account to create');
    // The homepage offers no signup and nothing to browse, so the FAQ must not
    // re-open that door or sell the village of local activities it replaced.
    // The bot-or-not answer names aloha@villagehale.com — the accountability
    // address, not the metaphor — so the domain is stripped before asserting.
    expect(answers).not.toContain('sign up');
    expect(answers.replaceAll('villagehale.com', '')).not.toContain('village');
  });

  it('keeps every claim inside what ships — no named method, no outcome promise', () => {
    const all = FAQ.map((item) => `${item.question} ${item.answer}`).join(' ');
    for (const overclaim of ['Ferber', 'guaranteed', 'will fix', 'March break', 'PA day']) {
      expect(all).not.toContain(overclaim);
    }
    expect(all).toContain('never diagnoses and never names a dose');
  });

  it('offers the record by a door a texting family has (claim-by-phone must ship first)', () => {
    // Same merge-order dependency as the landing's receipts line: web sign-in is
    // Google + magic link today, and a texted family has no email address.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).toContain('sign in with your phone number');
  });

  it('scopes the never-texts-first promise to what CASL actually buys the reader', () => {
    // "Hale never texts you first" was flatly false three questions later, where
    // the same page describes the Sunday week plan and the registration heads-up —
    // both real, both default-on (loop_prefs.catWeeklyPlan). The promise a parent
    // is owed is that Hale never COLD-texts: an unknown number is never messaged.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).not.toContain('never texts you first');
    expect([...answers.matchAll(/never texts a number that hasn’t texted it first/g)]).toHaveLength(
      2,
    );
    // Positive control: the proactive message the old claim contradicted is
    // still described, so this passes because the claim was scoped, not because
    // the page went quiet about what Hale sends.
    expect(answers.toLowerCase()).toContain('a heads-up the week a registration opens');
  });

  it('claims no Sunday brief — that one needs a SECOND flag, not F14', () => {
    // The registration ladder, the watched spots and the evening check-in are all
    // one F14_ENABLED flip from sending, and the founder has ruled that
    // merged-and-tested is claimable. The Sunday text is not in that set: the
    // send is additionally gated by LOOP_SEND_ENABLED, which defaults OFF
    // ("compose-not-send until the founder flips it"), so flipping F14 alone
    // would not make it true. The site was claiming it anyway.
    const all = FAQ.map((item) => `${item.question} ${item.answer}`).join(' ');
    expect(all).not.toContain('Sunday');
    expect(all).not.toContain('A brief on Monday');
    expect(all).not.toContain('Monday morning');
  });

  it('answers the two roadmap questions with "Not yet." and claims nothing else', () => {
    // This is where the roadmap honestly lives: a landing page that advertises
    // what it has not built teaches a reader to discount everything else on it.
    const find = (q: string) => FAQ.find((item) => item.question === q)?.answer ?? '';
    const reviews = find('Will you tell me whether a class is any good?');
    const travel = find('Can you help when we travel?');
    for (const answer of [reviews, travel]) expect(answer.startsWith('Not yet.')).toBe(true);
    // The travel answer STOPS. `find_activities` takes { subject, window?, childId? }
    // and nothing else, and its own description forbids a location in `subject`
    // — the town is the family's on-file GTA one, attached from their record. A
    // parent who asks what is on in another city gets a search run against their
    // own town, so "ask me about another city" would be a claim with no code
    // under it.
    expect(travel).toBe(
      'Not yet. Today I watch registration and what’s on where you live, in the GTA.',
    );
    // Reviews may say what is real today (the asking) and what is wanted next,
    // and must promise no corpus: there is no table, no verdict vocabulary, no
    // k-threshold, and a web find has no stable id to hang a review on.
    expect(reviews).toContain('asks how it went');
    expect(reviews).toContain('never anyone’s words');
    // And it claims no EFFECT for the asking. `family_check_in_notes` carries
    // "NOTHING READS THIS TODAY" in its own schema comment, the only reader
    // outside the writer is the rights export, and the activity follow-up reply
    // is deliberately unhandled — so "your next suggestions get better" is the
    // same unbuilt-claim shape the landing bans in §3, moved to the page a
    // doubting parent reads second. The answer may say what Hale DOES (ask) and
    // what it WANTS to build; it may not say what the asking achieves.
    for (const effect of [
      'get better',
      'gets better',
      'better for your family',
      'learns',
      'remembers',
      'improve',
    ]) {
      expect(reviews.toLowerCase(), `${effect} must not appear`).not.toContain(effect);
    }
  });

  it('promises no quiet between the legs — the evening check-in asks every night', () => {
    // The evening check-in is merged and tested and asks at 20:00 local EVERY
    // night, stepping down to weekly only after three unanswered evenings. One
    // flag flip from sending, "It is quiet in between" becomes false for every
    // family that answers — so the answer names the legs and stops.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).not.toContain('quiet in between');
    expect(answers).not.toContain('then quiet');
    // Positive control: the cadence answer is still here and still names what
    // Hale sends, so the absence above is a promise withheld, not a lost answer.
    expect(answers.toLowerCase()).toContain('a heads-up the week a registration opens');
    expect(answers).toContain('STOP works at any time');
  });

  it('reaches consent and privacy inside the top four questions', () => {
    // Risk → time → money. They were Q6 and Q9 of 11, below the fold and behind
    // closed disclosures, on a product whose stated moat is privacy.
    const top = FAQ.slice(0, 4).map((item) => item.question);
    expect(top).toContain('Does Hale do anything without asking?');
    expect(top).toContain('Is my family’s data private?');
    // And cost still comes after them, not before.
    const index = (q: string) => FAQ.findIndex((item) => item.question === q);
    expect(index('Is Hale free?')).toBeGreaterThan(index('Is my family’s data private?'));
  });

  it('names the municipality count the radar actually watches, not a spelled guess', () => {
    // The landing derives its count from the list; the FAQ used to spell
    // "fifteen" by hand, so a sixteenth town made the two pages disagree.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).toContain(`${MUNICIPALITY_COUNT} GTA municipalities`);
    expect(answers).not.toContain('fifteen');
  });

  it('carries the Canadian residency and teen-redaction posture (hard rule #1)', () => {
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).toContain('PIPEDA');
    expect(answers).toContain('Law 25');
    expect(answers).toContain('redacted from parents by default');
  });

  it('drives the FAQPage schema too, so an answer engine reads the served list', () => {
    const entities = faqJsonLd().mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(FAQ.length);
    expect(entities.map((q) => q.name)).toContain('What is Hale?');
  });
});
