import { describe, expect, it } from 'vitest';
import { readMemoryRequest, readMemoryTargets } from './request';
import { asked, refsFor, scriptedMemoryScreen } from './scripted-memory-screen.fixture';

/**
 * Request mechanics only: what is handed to the meaning screen and what is made of its
 * answer. The screen here is scripted per test; the model's reading of real wording is
 * the meaning-screen eval (apps/worker/evals/meaning-screen-fixtures.mjs).
 */

describe('readMemoryRequest', () => {
  it('passes the parent text to the memory_request screen and keeps its reading', async () => {
    const screen = scriptedMemoryScreen({
      request: () => asked('correct', { target: '游泳课', value: '周四', language: 'zh' }),
    });
    expect(await readMemoryRequest(screen, '  游泳课改到周四了  ')).toEqual({
      kind: 'correct',
      target: '游泳课',
      value: '周四',
      language: 'zh',
    });
    expect(screen.calls).toEqual([{ screen: 'memory_request', text: '游泳课改到周四了' }]);
  });

  it('is not about memory when the screen says none, and unread when it does not answer', async () => {
    const none = scriptedMemoryScreen({ request: () => ({ hit: false, memory: 'none' }) });
    expect(await readMemoryRequest(none, 'what time is swim tomorrow?')).toBeNull();
    const unread = scriptedMemoryScreen({ request: () => null });
    expect(await readMemoryRequest(unread, 'forget the swim thing')).toBe('unread');
  });

  it('reads nothing for an empty text', async () => {
    const screen = scriptedMemoryScreen({ request: () => asked('list') });
    expect(await readMemoryRequest(screen, '   ')).toBeNull();
    expect(screen.calls).toEqual([]);
  });

  it('keeps a target only for forget and correct, a value only for correct, and a real tag', async () => {
    const screen = scriptedMemoryScreen({
      request: () => asked('list', { target: 'stray', value: 'stray', language: 'not a tag' }),
    });
    expect(await readMemoryRequest(screen, 'que sais-tu de nous ?')).toEqual({
      kind: 'list',
      target: '',
      value: '',
      language: null,
    });
    const forget = scriptedMemoryScreen({
      request: () => asked('forget', { target: 'notre adresse', value: 'stray', language: 'fr' }),
    });
    expect(await readMemoryRequest(forget, 'oublie notre adresse')).toMatchObject({
      kind: 'forget',
      target: 'notre adresse',
      value: '',
      language: 'fr',
    });
  });
});

describe('readMemoryTargets', () => {
  const candidates = [
    { id: 'a', line: 'swimming: saturday class (source: the parent told Hale)' },
    { id: 'b', line: 'district: midtown (source: their calendar)' },
  ];

  it('shows each candidate by a ref only this call knows, newest first, and maps refs back', async () => {
    const screen = scriptedMemoryScreen({
      target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'district') }),
    });
    const read = await readMemoryTargets(screen, 'forget where we live', candidates);
    expect(read).toEqual({ chosen: [candidates[1]], value: '', key: '' });
    expect(screen.calls).toEqual([
      {
        screen: 'memory_target',
        text: 'forget where we live',
        facts: [`f1: ${candidates[0]?.line}`, `f2: ${candidates[1]?.line}`],
      },
    ]);
  });

  it('drops a ref that is not one of the candidates and a repeat', async () => {
    const screen = scriptedMemoryScreen({
      target: () => ({ hit: true, refs: ['f9', 'f1', 'f1'] }),
    });
    const read = await readMemoryTargets(screen, 'forget the swim one', candidates);
    expect(read).toEqual({ chosen: [candidates[0]], value: '', key: '' });
  });

  it('carries a corrected value and a proposed key, and is unread when the screen is', async () => {
    const screen = scriptedMemoryScreen({
      target: () => ({ hit: false, refs: [], value: 'Laval', key: 'home_city' }),
    });
    expect(await readMemoryTargets(screen, 'we live in Laval now', candidates)).toEqual({
      chosen: [],
      value: 'Laval',
      key: 'home_city',
    });
    const unread = scriptedMemoryScreen({ target: () => null });
    expect(await readMemoryTargets(unread, 'forget it', candidates)).toBe('unread');
  });
});
