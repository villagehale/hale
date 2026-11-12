import { describe, expect, it } from 'vitest';
import { namesFacts, quotesParent } from './parent-quote';

// Invented hosts, plus the real shapes of the multi-tenant registration platforms
// (ActiveNet, Amilia, PerfectMind), whose host carries a platform or a short code.
const ACTIVENET = 'anc.ca.apm.activecommunities.com';
const AMILIA = 'app.amilia.com';
const SWIM = { activity: 'Preschool Swim', host: 'register.example-rec.test' };

describe('namesFacts: whole words of the name or the site, never a fragment', () => {
  it.each([
    ['cancel', { activity: null, host: ACTIVENET }],
    ['please cancel', { activity: 'Preschool Swim', host: ACTIVENET }],
    ['Nancy can dance', { activity: null, host: ACTIVENET }],
    ['happy to approve it', { activity: null, host: AMILIA }],
    ['yes, register her', SWIM],
    ['yes do it on perfectmind', { activity: null, host: 'cityofkingston.perfectmind.com' }],
    ['yes for www', { activity: null, host: 'www.toronto.ca' }],
  ])('%j names nothing of %j', (words, facts) => {
    expect(namesFacts(words, facts)).toBe(false);
  });

  it.each([
    ['cancel the swim one', SWIM],
    ['the PRESCHOOL one', SWIM],
    ['the example-rec one', SWIM],
    ['the Toronto one', { activity: null, host: 'www.toronto.ca' }],
    ['the cityofkingston one', { activity: null, host: 'cityofkingston.perfectmind.com' }],
  ])('%j names %j', (words, facts) => {
    expect(namesFacts(words, facts)).toBe(true);
  });

  it('a word shorter than four letters names nothing on its own; the whole name written out does', () => {
    const gym = { activity: 'Gym Tots', host: 'gym.example-play.test' };
    expect(namesFacts('the gym one', gym)).toBe(false);
    expect(namesFacts('the tots class', gym)).toBe(true);
    const art = { activity: 'Art & Me', host: 'register.example-rec.test' };
    expect(namesFacts('the art class', art)).toBe(false);
    expect(namesFacts('yes to art & me', art)).toBe(true);
    expect(namesFacts('me and art', art)).toBe(false);
  });

  it('a name with a long word is not named by its short words in a row', () => {
    const facts = { activity: 'Swim for the Little Ones', host: 'register.example-rec.test' };
    expect(namesFacts('thanks for the update', facts)).toBe(false);
    expect(namesFacts('the little ones swim', facts)).toBe(true);
  });
});

describe('quotesParent', () => {
  it('holds only on words the parent wrote, case and spacing aside', () => {
    expect(quotesParent('Cancel  the Swim one', 'cancel the swim one')).toBe(true);
    expect(quotesParent('cancel it', 'the swim one')).toBe(false);
    expect(quotesParent('cancel it', null)).toBe(false);
    expect(quotesParent('cancel it', '  ')).toBe(false);
  });
});
