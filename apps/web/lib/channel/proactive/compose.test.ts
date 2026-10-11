import { describe, expect, it } from 'vitest';
import {
  WRITER_TOOL_SCHEMA,
  composeProactiveBatch,
  readWriterText,
  withActivityLinks,
} from './compose';
import type { SnapshotCandidate } from './snapshot';

const ITEM: SnapshotCandidate = {
  id: 'c1',
  what: 'Paper lantern craft at the Elm Street library',
  why: 'Saturday afternoon is open',
  sourceUrl: 'https://example.test/lantern',
  worthlessAfter: null,
  parentRequested: false,
};

describe('withActivityLinks', () => {
  it('appends the page when the text names the activity and omits the link', () => {
    const linked = withActivityLinks(
      'Paper lantern craft at the Elm Street library is on Saturday afternoon.',
      [ITEM],
    );
    expect(linked).toBe(
      'Paper lantern craft at the Elm Street library is on Saturday afternoon. https://example.test/lantern',
    );
  });

  it('does not attach a link the text never named, or one it already carries', () => {
    expect(withActivityLinks('Soccer is on this weekend.', [ITEM])).toBe(
      'Soccer is on this weekend.',
    );
    const carried = 'Paper lantern craft at the Elm Street library: https://example.test/lantern';
    expect(withActivityLinks(carried, [ITEM])).toBe(carried);
  });
});

describe('readWriterText', () => {
  it('keeps a grounded text and refuses one with a link or a time it was not given', () => {
    expect(readWriterText({ message: 'Lantern craft Saturday.' }, [ITEM])).toEqual({
      message: 'Lantern craft Saturday.',
    });
    expect(readWriterText({ message: 'See https://other.test/x' }, [ITEM])).toEqual({
      skipped: 'invented',
    });
    expect(readWriterText({ message: 'It starts at 2:30 on Saturday.' }, [ITEM])).toEqual({
      skipped: 'invented',
    });
    expect(readWriterText({ message: '   ' }, [ITEM])).toEqual({ skipped: 'unparsed' });
    expect(readWriterText({ message: 'ok', extra: true }, [ITEM])).toEqual({
      skipped: 'unparsed',
    });
  });
});

describe('the writer tool schema', () => {
  it('is one message and nothing else', () => {
    expect(WRITER_TOOL_SCHEMA.required).toEqual(['message']);
    expect(WRITER_TOOL_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('composeProactiveBatch', () => {
  it('sends nothing, by name, when there is no model', async () => {
    await expect(
      composeProactiveBatch({ items: [ITEM], client: null, cadenceNote: null }),
    ).resolves.toEqual({ skipped: 'no_client' });
  });
});
