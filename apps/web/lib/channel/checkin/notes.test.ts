import { describe, expect, it } from 'vitest';
import { isNotKept } from './notes';

describe('the categories Hale does not write down', () => {
  it('refuses every category the memory contract names', () => {
    const refused = [
      'Rough one, Mia had a fever all afternoon',
      'We finally got the ADHD diagnosis back',
      'Leo starts therapy on Thursday',
      'Long day at the custody hearing',
      'Our lawyer called about the divorce',
      'The visa interview went badly',
      'We might not make rent this month',
      'Church picnic ran late',
      'Talked to the kids about the election',
    ];
    for (const body of refused) expect(isNotKept(body), body).toBe(true);
  });

  it('keeps an ordinary evening', () => {
    const kept = [
      'Good day - park after daycare and bed by 7',
      'Swim class was a hit, Leo wants to go back',
      'Bit of a meltdown at dinner but we got there',
      'Nothing much, pyjama day',
      'Grandma visited and they baked',
    ];
    for (const body of kept) expect(isNotKept(body), body).toBe(false);
  });

  it('matches whole words, so an innocent sentence is not swallowed by a substring', () => {
    // 'race' inside 'braces', 'meds' inside 'Medina', 'rent' inside 'parenting'.
    expect(isNotKept('She got her braces tightened... ')).toBe(false);
    expect(isNotKept('We went to the Medina street festival')).toBe(false);
    expect(isNotKept('Parenting win: both asleep by 7')).toBe(false);
  });

  it('folds accents and punctuation before it reads, so spelling cannot slip past it', () => {
    expect(isNotKept('La thérapie a bien été')).toBe(true);
    expect(isNotKept('rough day. fever, again!')).toBe(true);
  });

  it('is not defeated by an s, which is the whole reason the plural is derived', () => {
    const refused = [
      'Her allergies were awful today',
      'Two seizures this week',
      'Both lawyers finally called back',
      'The therapists want another session',
      'Waiting on the diagnoses',
    ];
    for (const body of refused) expect(isNotKept(body), body).toBe(true);
  });

  it('refuses the markers a parent is most likely to actually type', () => {
    const refused = [
      'Everyone has the flu here',
      'Covid again, whole house down',
      'Six stitches after the park',
      'We told them we are Muslim and they were lovely',
      'My sister came out as gay and the kids had questions',
      'Police were at the door about my ex',
      'First trip to the food bank this week',
      'I am pregnant and exhausted',
    ];
    for (const body of refused) expect(isNotKept(body), body).toBe(true);
  });
});
