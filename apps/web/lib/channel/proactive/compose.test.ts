import { describe, expect, it, vi } from 'vitest';
import {
  WRITER_TOOL_SCHEMA,
  composeProactiveBatch,
  readWriterText,
  withActivityLinks,
} from './compose';
import { LINE_CHARS, TEXT_CHARS, type ToolCandidate, writerContext } from './tools';

const ITEM: ToolCandidate = {
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

  it('refuses, by name, a text longer than one text is', () => {
    const line = 'Lantern craft Saturday.';
    const fits = Array.from(
      { length: Math.floor(TEXT_CHARS / (line.length + 1)) },
      () => line,
    ).join(' ');
    expect(fits.length).toBeLessThanOrEqual(TEXT_CHARS);
    expect(readWriterText({ message: fits }, [ITEM])).toEqual({ message: fits });
    const over = `${fits} ${line} ${line}`;
    expect(over.length).toBeGreaterThan(TEXT_CHARS);
    expect(readWriterText({ message: over }, [ITEM])).toEqual({ skipped: 'over_length' });
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
    await expect(composeProactiveBatch({ items: [ITEM], client: null })).resolves.toEqual({
      skipped: 'no_client',
    });
  });

  it('logs a failed model call by its error class, never the message', async () => {
    class ProviderError extends Error {
      status = 400;
    }
    const fail = () => {
      throw new ProviderError('400 invalid request: "note":"QUOTED-CADENCE-NOTE"');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await composeProactiveBatch({
      items: [ITEM],
      client: { messages: { create: fail, stream: fail } } as never,
    });
    expect(result).toEqual({ skipped: 'model_failed' });
    const logged = errors.mock.calls.find(
      ([, line]) => line === 'proactive writer: model call failed',
    );
    expect(logged?.[0]).toEqual({ err: 'ProviderError' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('QUOTED-CADENCE-NOTE');
    errors.mockRestore();
  });
});

describe('writerContext', () => {
  it('cuts the cadence note to one bounded line before the writer sees it', () => {
    const note = `less, please\n${'y'.repeat(400)}`;
    expect(JSON.parse(writerContext([ITEM], note)).note).toBe(
      `less, please ${'y'.repeat(400)}`.slice(0, LINE_CHARS),
    );
  });
});
