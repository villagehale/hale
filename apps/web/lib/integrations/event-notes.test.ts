import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_NOTES_FAILED,
  boundEventNotesReader,
  createEventNotesReader,
  legacyDescriptionHash,
  mapLimited,
  migrateLegacyNotes,
  notesSourceHash,
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
    const h = notesSourceHash('t', 'x');
    expect(
      sameEventNotes({ sourceHash: h, failedReads: 1 }, { sourceHash: h, failedReads: 2 }),
    ).toBe(false);
    expect(sameEventNotes({ sourceHash: h }, { sourceHash: h, failedReads: 0 })).toBe(true);
  });

  it('compares facts and source hash', () => {
    const h = notesSourceHash('t', 'x');
    expect(sameEventNotes({ parking: 'A', sourceHash: h }, { parking: 'A', sourceHash: h })).toBe(
      true,
    );
    expect(sameEventNotes({ parking: 'A', sourceHash: h }, { parking: 'B', sourceHash: h })).toBe(
      false,
    );
    expect(sameEventNotes(null, undefined)).toBe(true);
  });
});

describe('notesSourceHash (Devin #930)', () => {
  it('a renamed event with the same description is a different source', () => {
    expect(notesSourceHash('Swim', 'Park on Elm')).not.toBe(
      notesSourceHash('Skate', 'Park on Elm'),
    );
    expect(notesSourceHash('Swim', 'Park on Elm')).toBe(notesSourceHash('Swim', 'Park on Elm'));
  });
});

describe('boundEventNotesReader (Devin #930)', () => {
  const input = { title: 'Swim', description: 'Park on Elm' };

  it('a read past the timeout is a failed read, not a stall', async () => {
    vi.useFakeTimers();
    try {
      const reader = boundEventNotesReader(() => new Promise(() => {}), { timeoutMs: 50 });
      const pending = reader(input);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe(EVENT_NOTES_FAILED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a thrown read is a failed read', async () => {
    const reader = boundEventNotesReader(async () => {
      throw new Error('boom');
    });
    await expect(reader(input)).resolves.toBe(EVENT_NOTES_FAILED);
  });

  it('stops starting reads past the sweep read cap (deferred, no model call)', async () => {
    const inner = vi.fn(async () => ({ sourceHash: 'h' }));
    const reader = boundEventNotesReader(inner, { maxReads: 2 });
    await reader(input);
    await reader(input);
    await expect(reader(input)).resolves.toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('stops starting reads past the sweep time budget', async () => {
    let t = 0;
    const inner = vi.fn(async () => ({ sourceHash: 'h' }));
    const reader = boundEventNotesReader(inner, { budgetMs: 100, now: () => t });
    await reader(input);
    t = 100;
    await expect(reader(input)).resolves.toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('mapLimited', () => {
  it('keeps order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

describe('migrateLegacyNotes (Devin #930)', () => {
  const legacy = { parking: 'A', sourceHash: legacyDescriptionHash('d') };
  it('rehashes an unchanged event, keeping facts', () => {
    expect(migrateLegacyNotes(legacy, 'Swim', 'Swim', 'd')).toEqual({
      parking: 'A',
      sourceHash: notesSourceHash('Swim', 'd'),
    });
  });
  it('leaves renamed, changed-description, new-format, and empty notes alone', () => {
    expect(migrateLegacyNotes(legacy, 'Swim', 'Skate', 'd')).toBe(legacy);
    expect(migrateLegacyNotes(legacy, 'Swim', 'Swim', 'e')).toBe(legacy);
    const cur = { sourceHash: notesSourceHash('Swim', 'd') };
    expect(migrateLegacyNotes(cur, 'Swim', 'Swim', 'd')).toBe(cur);
    expect(migrateLegacyNotes(null, 'Swim', 'Swim', 'd')).toBeNull();
  });
});
