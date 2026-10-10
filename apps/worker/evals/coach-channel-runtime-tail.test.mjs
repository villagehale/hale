import { describe, expect, it } from 'vitest';
import { modelProse, nearbyCountWasAppended } from './coach-channel-runtime-tail.mjs';

const CLAUSE = '3 families near you say Riverdale Library is worth it.';
const URL = 'https://www.torontopubliclibrary.ca/programs-and-classes/';
const LINKS = [{ title: 'Riverdale story time', url: URL }];
const MODEL = "Saturday's already got soccer practice at 10am at Cedarvale Park. Riverdale story time is Sat Aug 8.";

describe('modelProse', () => {
  it('drops the nearby clause and the activity URL from the sentence budget', () => {
    const reply = `${MODEL} ${CLAUSE} ${URL}`;
    expect(modelProse(reply, { nearbyClause: CLAUSE, links: LINKS })).toBe(MODEL);
  });

  it('drops the clause when it is the whole suffix', () => {
    expect(modelProse(`${MODEL} ${CLAUSE}`, { nearbyClause: CLAUSE, links: LINKS })).toBe(MODEL);
  });

  it('still drops a plan offer and a referral block', () => {
    const offer = 'Want me to send the full plan?';
    expect(modelProse(`${MODEL} ${offer}`, { appended: offer })).toBe(MODEL);
  });

  it('leaves a clause the model wrote in the middle', () => {
    const reply = `Before. ${CLAUSE} After that, soccer.`;
    expect(modelProse(reply, { nearbyClause: CLAUSE, links: LINKS })).toBe(reply);
  });
});

describe('nearbyCountWasAppended', () => {
  it('is true for the clause alone and for the clause followed by the page URL', () => {
    expect(nearbyCountWasAppended(`${MODEL} ${CLAUSE}`, CLAUSE, LINKS)).toBe(true);
    expect(nearbyCountWasAppended(`${MODEL} ${CLAUSE} ${URL}`, CLAUSE, LINKS)).toBe(true);
  });

  it('is false when the clause is not the runtime suffix', () => {
    expect(nearbyCountWasAppended(`Before. ${CLAUSE} After.`, CLAUSE, LINKS)).toBe(false);
    expect(nearbyCountWasAppended(MODEL, CLAUSE, LINKS)).toBe(false);
  });
});
