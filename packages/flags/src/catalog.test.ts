import { describe, expect, it } from 'vitest';
import { envVariant, getFlag, parseEnvBoolean, reportInexactFlagValue } from './catalog.js';
import { isEnabled } from './evaluate.js';

describe('reportInexactFlagValue', () => {
  const f14 = getFlag('f14');

  it('reports wrong case and whitespace on an exact word', () => {
    expect(reportInexactFlagValue(f14, 'True')).toEqual({
      key: 'f14',
      env: 'F14_ENABLED',
      raw: 'True',
      expected: 'true',
      faults: ['wrong-case'],
    });
    expect(reportInexactFlagValue(f14, 'true\n')).toEqual({
      key: 'f14',
      env: 'F14_ENABLED',
      raw: 'true\n',
      expected: 'true',
      faults: ['whitespace'],
    });
    expect(reportInexactFlagValue(f14, ' True\n')).toMatchObject({
      expected: 'true',
      faults: ['whitespace', 'wrong-case'],
    });
  });

  it('stays quiet for the exact word, a different word, and an unset value', () => {
    expect(reportInexactFlagValue(f14, 'true')).toBeNull();
    expect(reportInexactFlagValue(f14, 'false')).toBeNull();
    expect(reportInexactFlagValue(f14, undefined)).toBeNull();
    expect(reportInexactFlagValue(f14, '')).toBeNull();
  });

  it('does not change how an exact flag evaluates', () => {
    expect(parseEnvBoolean(f14, { F14_ENABLED: 'True' })).toBe(false);
    expect(parseEnvBoolean(f14, { F14_ENABLED: 'true\n' })).toBe(false);
    expect(parseEnvBoolean(f14, { F14_ENABLED: 'true' })).toBe(true);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'True' })).toBe(false);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'true\n' })).toBe(false);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'true' })).toBe(true);
  });

  it('lets a trimmed parser keep a trailing newline and still reports wrong case', () => {
    const stickers = getFlag('linq-stickers');
    expect(reportInexactFlagValue(stickers, 'true\n')).toBeNull();
    expect(reportInexactFlagValue(stickers, ' true\n')).toBeNull();
    expect(parseEnvBoolean(stickers, { LINQ_STICKERS_ENABLED: 'true\n' })).toBe(true);
    expect(reportInexactFlagValue(stickers, 'True')).toMatchObject({
      expected: 'true',
      faults: ['wrong-case'],
    });
    // The newline is already accepted. Only the case keeps this off.
    expect(reportInexactFlagValue(stickers, ' True\n')).toEqual({
      key: 'linq-stickers',
      env: 'LINQ_STICKERS_ENABLED',
      raw: ' True\n',
      expected: 'true',
      faults: ['wrong-case'],
    });
    expect(parseEnvBoolean(stickers, { LINQ_STICKERS_ENABLED: 'True' })).toBe(false);
    expect(parseEnvBoolean(stickers, { LINQ_STICKERS_ENABLED: ' true\n' })).toBe(true);
  });

  it('reports an exact-on miss and a not-exact-false newline that stays on', () => {
    const watch = getFlag('social-watchlist');
    expect(reportInexactFlagValue(watch, 'On')).toMatchObject({
      expected: 'on',
      faults: ['wrong-case'],
    });
    expect(parseEnvBoolean(watch, { SOCIAL_WATCHLIST: 'On' })).toBe(false);

    const search = getFlag('general-answer-search');
    expect(reportInexactFlagValue(search, 'false\n')).toMatchObject({
      expected: 'false',
      faults: ['whitespace'],
    });
    expect(parseEnvBoolean(search, { GENERAL_ANSWER_SEARCH_ENABLED: 'false\n' })).toBe(true);
  });

  it('reports the inverted voice kill when the case or the newline is wrong', () => {
    const voice = getFlag('voice');
    expect(reportInexactFlagValue(voice, 'True')).toMatchObject({
      expected: 'true',
      faults: ['wrong-case'],
    });
    expect(parseEnvBoolean(voice, { VOICE_DISABLED: 'True' })).toBe(true);
    expect(parseEnvBoolean(voice, { VOICE_DISABLED: 'true' })).toBe(false);
    expect(reportInexactFlagValue(voice, 'true\n')).toMatchObject({ faults: ['whitespace'] });
  });

  it('reports a multivariate variant the env parser will not read', () => {
    const cadence = getFlag('proactive-cadence');
    expect(reportInexactFlagValue(cadence, 'shadow\n')?.faults).toEqual(['whitespace']);
    expect(envVariant(cadence, { PROACTIVE_CADENCE: 'shadow\n' })).toBe('off');
    expect(reportInexactFlagValue(cadence, 'shadow')).toBeNull();

    const claim = getFlag('claim-reader-mode');
    // The off variant is read trimmed, so a trailing newline still kills.
    expect(reportInexactFlagValue(claim, 'off\n')).toBeNull();
    expect(envVariant(claim, { CLAIM_READER_MODE: 'off\n' })).toBe('off');
    expect(reportInexactFlagValue(claim, ' Off\n')?.faults).toEqual(['wrong-case']);
    expect(reportInexactFlagValue(claim, ' False\n')?.faults).toEqual(['wrong-case']);
    // A non-kill variant is exact, so case and a newline are both misses.
    expect(reportInexactFlagValue(claim, ' Shadow\n')?.faults).toEqual([
      'whitespace',
      'wrong-case',
    ]);
    expect(reportInexactFlagValue(claim, 'Shadow')).toMatchObject({
      expected: 'shadow',
      faults: ['wrong-case'],
    });
    expect(envVariant(claim, { CLAIM_READER_MODE: 'Shadow' })).toBe('enforce');
  });
});
