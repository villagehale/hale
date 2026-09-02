import { describe, expect, it } from 'vitest';
import { matchKeyword } from './keywords';

describe('matchKeyword', () => {
  it('matches every CASL stop word regardless of case or surrounding punctuation', () => {
    for (const raw of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'end', 'Quit!', 'cancel']) {
      expect(matchKeyword(raw), raw).toEqual({ keyword: 'stop', language: 'en' });
    }
  });

  it('matches the help and start words', () => {
    expect(matchKeyword('HELP')).toEqual({ keyword: 'help', language: 'en' });
    expect(matchKeyword('info')).toEqual({ keyword: 'help', language: 'en' });
    expect(matchKeyword('Start')).toEqual({ keyword: 'start', language: 'en' });
  });

  /**
   * The five keywords the CTA's Canadian Common Short Code Compliance Policies (v2.1
   * §3.1) make mandatory are STOP, ARRET, HELP, AIDE and INFO — "regardless of the
   * intended audience". Each French one carries the same CASL semantics as its English
   * twin, and carries `fr` with it, because the reply to ARRET and AIDE must be French.
   */
  it('claims the French keywords with the same semantics as their English twins', () => {
    for (const raw of ['ARRET', 'arret', 'ARRÊT', ' Arrêt. ']) {
      expect(matchKeyword(raw), raw).toEqual({ keyword: 'stop', language: 'fr' });
    }
    for (const raw of ['AIDE', 'aide', 'Aide!']) {
      expect(matchKeyword(raw), raw).toEqual({ keyword: 'help', language: 'fr' });
    }
    for (const raw of ['DEBUT', 'debut', 'DÉBUT', 'Début.']) {
      expect(matchKeyword(raw), raw).toEqual({ keyword: 'start', language: 'fr' });
    }
  });

  /**
   * A phone may send an accented letter as one code point or as a letter plus a
   * combining mark, and the two are indistinguishable on the screen. Enumerating
   * spellings would have claimed the first and dropped the second — an unsubscribe lost
   * to a Unicode normalization form nobody chose.
   */
  it('reads a decomposed accent as the same keyword the composed one is', () => {
    // Escaped rather than typed, so an editor saving this file cannot collapse the two
    // forms into one — the control assertion is what keeps them genuinely different.
    const decomposed = 'ARRE\u0302T';
    expect(decomposed).not.toBe('ARR\u00CAT');
    expect(matchKeyword(decomposed)).toEqual({ keyword: 'stop', language: 'fr' });
    expect(matchKeyword('de\u0301but')).toEqual({ keyword: 'start', language: 'fr' });
  });

  it('does NOT treat a sentence containing a keyword as the keyword', () => {
    // The whole reason matching is exact: these are families still talking to us.
    expect(matchKeyword('please stop sending me the swim times')).toBeNull();
    expect(matchKeyword('can you help me find a daycare')).toBeNull();
    expect(matchKeyword('we start school next week')).toBeNull();
    expect(matchKeyword('cancel my daughter’s class?')).toBeNull();
  });

  /**
   * The same exactness in French, and it bites harder here: `arrêt` is the ordinary word
   * for a bus stop and `aide` for help of any kind, so a substring reading would
   * unsubscribe a parent asking about the bus.
   */
  it('does NOT treat an ordinary French sentence as a French keyword', () => {
    expect(matchKeyword("l'arrêt d'autobus est ou?")).toBeNull();
    expect(matchKeyword("j'ai besoin d'aide pour trouver une garderie")).toBeNull();
    expect(matchKeyword("le début de l'annee scolaire")).toBeNull();
  });

  it('returns null for ordinary intake answers', () => {
    expect(matchKeyword('Maya is 4 and Leo is 1, M5V 2T6')).toBeNull();
    expect(matchKeyword('')).toBeNull();
  });
});
