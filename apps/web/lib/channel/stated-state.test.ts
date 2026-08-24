import { describe, expect, it } from 'vitest';
import { readStatedState } from './stated-state';

/**
 * VIL-294 · the inbound half — the corpus is the founder's own thread, verbatim.
 *
 * All 54 parent messages sent between 2026-08-11 and 2026-08-22, in the order they
 * arrived. Exactly ONE of them states that something Hale raised is already handled;
 * the other 53 are questions, instructions, greetings, corrections and observations,
 * and a reader that mints on any of them silences a legal-obligation reminder for a
 * window months wide.
 *
 * The whole thread rather than a hand-picked selection, because the near misses are the
 * point: "Yes, please add it", "You said 18 month baby visit" and "can you move Noah's
 * well-baby visit to next Thursday" all sit inside a two-minute span of the sentence
 * that MUST mint, and every one of them is about the same appointment.
 */
const FOUNDER_THREAD: readonly string[] = [
  'What else can you do',
  "How's the weather today",
  'Is there a good park to play nearby',
  'Any park nearby',
  'Hey',
  'Find me a event for this weekend',
  'Sure',
  'How do you add it to my calendar',
  'I know that library drop in event, it is legit',
  'My son is still co sleep how to get him sleep alone',
  'When should he start solid food',
  'How much do you know about me',
  'Too slow bro',
  'How to make my son sleep on his own',
  'Give me a detailed plan',
  'But he still wake up at night and cry and we need to go in and sleep with him',
  'You missed the point why he still cry at night and we need to sleep with him',
  'Does he need a eye exam now',
  'Find a optometrist near me',
  'What can we do tomorrow',
  'YES INTROS',
  'Yes we booked already',
  'How do I refer others to use this',
  'Hello',
  "What's the link",
  'Hello.',
  "What's up?",
  'I think so September 1st is coming up, and we need to sign up for the fall season',
  'community activity. Right?',
  'And can we do it over the phone?',
  'No. I think we need to do everything on the in the phone.',
  'Hi.',
  'Hi.',
  'Hi',
  'hey, what have we got on this week?',
  'my two year old keeps waking at five in the morning, any ideas?',
  "can you move Noah's well-baby visit to next Thursday at half past four?",
  'please put swim lessons on the calendar for this Thursday at four thirty',
  'add swim lessons to the calendar for Thursday at four thirty please',
  'hey, what have we got on this week?',
  'Add to my week',
  'You said 18 month baby visit',
  'Yes, please add it',
  'Hi',
  'I wanna find something to do for Noah from September to December what is available near me',
  'Wha about cartwheel gym did you find anything there',
  'Yes, please',
  "There's a gym in Georgetown for baby and kids called cartwheel",
  'I wanna find something to do for Noah from September to December, what is available near me',
  'What about Cartwheels gym, did you find anything there?',
  'Can you watch swim registration for Noah at Gellert this fall?',
  'what is the swim class schedule',
  'Yes, please',
  'Tiny gym',
];

/** The one message in the thread that states a durable fact Hale must write down. */
const THE_ONE = 'Yes we booked already';

/** Every message that must read as nothing at all. */
const NEGATIVES = FOUNDER_THREAD.filter((body) => body !== THE_ONE);

/** The gate itself, so the poisoned control below can run the SAME predicate. */
function minters(corpus: readonly string[]): string[] {
  return corpus.filter((body) => readStatedState(body) !== null);
}

describe('readStatedState — the founder thread, 2026-08-11 → 2026-08-22', () => {
  it('reads the Aug 13 reply as the parent stating a visit is already handled', () => {
    expect(readStatedState(THE_ONE)).toBe('health_visit_handled');
  });

  it('mints nothing on the other 53 messages', () => {
    expect(NEGATIVES).toHaveLength(53);
    expect(minters(NEGATIVES)).toEqual([]);
  });

  /**
   * The positive control for the negative assertion above. `toEqual([])` passes just as
   * happily against a reader that returns null for everything, so the gate is run once
   * more over a corpus that DOES contain a minting sentence and must come back non-empty.
   * A reader that stopped reading anything at all fails here instead of shipping green.
   */
  it('is a gate with teeth: the same predicate catches a poisoned corpus', () => {
    expect(minters([...NEGATIVES, THE_ONE])).toEqual([THE_ONE]);
  });
});

describe('readStatedState — what a statement of an already-handled visit looks like', () => {
  it.each([
    'we booked already',
    'already booked',
    "we've booked it",
    'we booked it last week',
    'I booked it yesterday',
    'we have an appointment next Tuesday',
    'we got an appointment for the 3rd',
    'we made the appointment',
    "it's booked",
    'we already went',
  ])('reads %j as handled', (body) => {
    expect(readStatedState(body)).toBe('health_visit_handled');
  });
});

describe('readStatedState — the near misses that must never write a suppression', () => {
  it.each([
    // The opposite of the claim, in the shapes a parent actually types.
    "we haven't booked yet",
    'not booked yet',
    'no we have not booked',
    "we can't book until September",
    // A future intent is not a done thing.
    "we'll book it tomorrow",
    "I'm going to book it",
    'we need to book that',
    'we have to book it still',
    // A question is an ask, not a statement.
    'should we book already?',
    'did we book that already?',
    // Somebody else's sentence, reported back.
    'you said it was booked',
    'you booked it right',
    // An instruction. The parent wants Hale to act, not to remember.
    'please book it',
    'book it',
    'add the appointment to my week',
  ])('leaves %j alone', (body) => {
    expect(readStatedState(body)).toBeNull();
  });
});

/**
 * The five frames that put a past participle in a sentence where nothing was done.
 *
 * A participle is not evidence on its own — "booked" appears verbatim in every one of
 * these, and in none of them is there an appointment. What settles it is the frame the
 * participle sits in, and each block below is one frame the reader must refuse.
 *
 * The cost is asymmetric and that is the whole design: refusing a true statement costs
 * one repeated nudge, and accepting a false one silences an immunization reminder for a
 * window months wide. So every frame here fails CLOSED.
 */
describe('readStatedState — a participle in a frame where nothing happened', () => {
  it.each([
    // Counterfactual. The modal perfect says the opposite of what the participle says.
    "we would have booked it if the slots weren't gone",
    "we would've booked it but they were full",
    'we could have booked it',
    'we should have booked it',
    'we might have booked it by now',
    'we wish we had booked it',
    'we almost booked it',
    'we were supposed to book it',
    // Progressive / future. The arranging is underway or ahead of us, not behind.
    "we're booking it tomorrow",
    'we are getting it booked tomorrow',
    "we're getting her booked in next week",
    'I am scheduling it this afternoon',
    'we are still sorting out the appointment',
    // Negation, in the auxiliaries the founder thread's own vocabulary missed.
    "we couldn't get the appointment booked",
    "we weren't booked in",
    "the clinic wouldn't book us in",
    'we booked it and then cancelled',
    // A question with no question mark, which is most questions in a text message.
    'have we booked it already',
    'did we already book the appointment',
    'is the appointment booked',
    // Somebody else's household. `already` is an adverb and cannot supply a subject.
    'my sister booked hers already',
    'our neighbours already booked theirs',
    'her cousin has the appointment on Friday',
  ])('leaves %j alone', (body) => {
    expect(readStatedState(body)).toBeNull();
  });
});

/**
 * Held out from the vocabulary, then run against it.
 *
 * Every sentence here was written to fool the guards above WITHOUT reusing their words,
 * and each one below is a paraphrase that got through on a first run and forced the frame
 * it names to be read structurally rather than as a longer list: an infinitive rather than
 * a list of modals, a reporting verb rather than a list of relatives, a hedge rather than
 * a list of denials. They are fixtures now so the next widening cannot quietly undo them.
 */
describe('readStatedState — paraphrases the vocabulary had not seen', () => {
  it.each([
    'we ought to have booked that back in June',
    'I ring them Monday to get her scheduled',
    'we failed to get the appointment booked',
    'we were this close to having it booked',
    'in a perfect world we booked this months ago',
    'wondering whether we already booked that one',
    'I thought we booked it',
    'the woman at playgroup said she booked hers already',
    'grandma reckons she already scheduled it',
  ])('leaves %j alone', (body) => {
    expect(readStatedState(body)).toBeNull();
  });

  /**
   * And the other direction, because a guard that refuses everything passes every test
   * above. These are statements no fixture taught the reader, and they must still mint —
   * including the one that opens on `just`, which the instruction prefix strips, and the
   * `-ing` word that is not one of the progressive forms.
   */
  it.each([
    'just confirming we booked her in for the 17th',
    'yes, we booked already, sorry for the slow reply',
    "we rebooked, she's in on the 8th",
    'the 3rd, we got the appointment',
  ])('still reads %j as handled', (body) => {
    expect(readStatedState(body)).toBe('health_visit_handled');
  });
});
