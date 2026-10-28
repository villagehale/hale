import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_NOTES_FAILED,
  createEventNotesReader,
  descriptionHash,
  sameEventNotes,
  toEventNotes,
} from './event-notes';

describe('toEventNotes', () => {
  it('keeps stated facts whole, with no length cap', () => {
    const long = `Lot B behind the rink. ${'Overflow on the street after 6pm. '.repeat(10)}`;
    expect(toEventNotes({ parking: long, bring: 'skates' }, 'h')).toEqual({
      parking: long.trim(),
      bring: 'skates',
      sourceHash: 'h',
    });
  });

  it('an empty reading keeps only the hash, so the description is not read again', () => {
    expect(toEventNotes({ parking: ' ', bring: '' }, 'h')).toEqual({ sourceHash: 'h' });
  });
});

describe('createEventNotesReader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('with no key there is no call and no notes', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const client = vi.fn();
    const read = createEventNotesReader(client);
    expect(await read({ title: 'Swim', description: 'Use the back lot' })).toBeNull();
    expect(client).not.toHaveBeenCalled();
  });

  it('an unavailable client is null (no attempt), so nothing extra is sent', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-placeholder');
    const read = createEventNotesReader(() => {
      throw new Error('boom');
    });
    expect(await read({ title: 'Swim', description: 'Use the back lot' })).toBeNull();
  });
  it('a model failure is EVENT_NOTES_FAILED, so the mirror can count it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-placeholder');
    const boom = vi.fn(async () => {
      throw new Error('model down');
    });
    const client = {
      messages: { create: boom, stream: boom },
    } as unknown as import('@hale/agent').AgentClient;
    const read = createEventNotesReader(() => client);
    expect(await read({ title: 'Swim', description: 'Use the back lot' })).toBe(EVENT_NOTES_FAILED);
    expect(boom).toHaveBeenCalled();
  });
});

describe('sameEventNotes', () => {
  it('a changed failure count is a change', () => {
    const h = descriptionHash('x');
    expect(
      sameEventNotes({ sourceHash: h, failedReads: 1 }, { sourceHash: h, failedReads: 2 }),
    ).toBe(false);
    expect(sameEventNotes({ sourceHash: h }, { sourceHash: h, failedReads: 0 })).toBe(true);
  });

  it('compares facts and source hash', () => {
    const h = descriptionHash('x');
    expect(sameEventNotes({ parking: 'A', sourceHash: h }, { parking: 'A', sourceHash: h })).toBe(
      true,
    );
    expect(sameEventNotes({ parking: 'A', sourceHash: h }, { parking: 'B', sourceHash: h })).toBe(
      false,
    );
    expect(sameEventNotes(null, undefined)).toBe(true);
  });
});
