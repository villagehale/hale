import { describe, expect, it } from 'vitest';
import { ERROR_TOKEN_CHARS, STACK_FRAMES, errorLabel, stackFrames } from './queue';

/** A frame as the log carries it: a function (or `<anonymous>`), then `file:line`. */
const FRAME = /^[\w$.<>[\] ]+ [^\s()]+:\d+$/;

describe('errorLabel', () => {
  const failure = (name: string, code?: unknown) =>
    Object.assign(new Error('Failing row contains (Pip, Riverside Rocks)'), { name, code });

  it('is the class alone, or the class and its code', () => {
    expect(errorLabel(new TypeError('x is not a function'))).toBe('TypeError');
    expect(errorLabel(failure('PostgresError', '23505'))).toBe('PostgresError:23505');
    expect(errorLabel(failure('Http2Error', 'ERR_HTTP2-STREAM.CANCEL'))).toBe(
      'Http2Error:ERR_HTTP2-STREAM.CANCEL',
    );
    expect(errorLabel(failure('PostgresError', 23505))).toBe('PostgresError');
    expect(errorLabel('not an error')).toBe('unknown');
  });

  it('reads a code that is not one short plain token as `other`', () => {
    const multiLine = '23514\nFailing row contains (Pip, Riverside Rocks)';
    expect(errorLabel(failure('PostgresError', multiLine))).toBe('PostgresError:other');
    expect(errorLabel(failure('PostgresError', 'rate limited'))).toBe('PostgresError:other');
    expect(errorLabel(failure('PostgresError', ''))).toBe('PostgresError:other');
    expect(errorLabel(failure('PostgresError', 'c'.repeat(ERROR_TOKEN_CHARS)))).toBe(
      `PostgresError:${'c'.repeat(ERROR_TOKEN_CHARS)}`,
    );
    expect(errorLabel(failure('PostgresError', 'c'.repeat(ERROR_TOKEN_CHARS + 1)))).toBe(
      'PostgresError:other',
    );
  });

  it('reads a class name that is over-long or not a plain token as `other`', () => {
    expect(errorLabel(failure('E'.repeat(ERROR_TOKEN_CHARS)))).toBe('E'.repeat(ERROR_TOKEN_CHARS));
    expect(errorLabel(failure('E'.repeat(ERROR_TOKEN_CHARS + 1)))).toBe('other');
    expect(errorLabel(failure('Pip said: text me less', '23505'))).toBe('other:23505');
    expect(errorLabel(failure('Error\nPip'))).toBe('other');
  });
});

describe('stackFrames', () => {
  function throwsDeep(depth: number): never {
    if (depth > 0) return throwsDeep(depth - 1);
    throw new TypeError("Cannot read properties of undefined (reading 'Pip')");
  }

  function caught(run: () => never): unknown {
    try {
      return run();
    } catch (err) {
      return err;
    }
  }

  it('is where it was thrown, as function and file:line, with no message text', () => {
    const err = caught(() => throwsDeep(0)) as Error;
    expect(err.stack).toContain("reading 'Pip'");

    const frames = stackFrames(err);

    expect(frames[0]).toMatch(/^throwsDeep \S+queue\.test\.ts:\d+$/);
    for (const frame of frames) expect(frame).toMatch(FRAME);
    expect(frames.join('\n')).not.toContain('Pip');
    expect(frames.join('\n')).not.toContain('Cannot read');
  });

  it('never reads a frame out of the message, however the message is shaped', () => {
    const err = new Error('refused\n    at leaked (rows/Pip.ts:1:1)\n    at /rows/Juno.ts:2:2');

    const frames = stackFrames(err);

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).toMatch(FRAME);
    expect(frames.join('\n')).not.toMatch(/Pip|Juno|leaked/);
  });

  it('reads no frames when the message is no longer where the stack opened with it', () => {
    const refusedRow = 'Error: Failing row contains\n    at Pip (rows/secret-child.ts:1:2)';
    const thrownAt = '    at handOff (lib/channel/proactive/queue.ts:10:3)';
    const reworded = Object.assign(new Error('wrapped: Failing row contains'), {
      stack: `${refusedRow}\n${thrownAt}`,
    });
    const blanked = Object.assign(new Error(''), { stack: `${refusedRow}\n${thrownAt}` });
    const intact = Object.assign(new Error('Failing row contains'), {
      stack: `Error: Failing row contains\n${thrownAt}`,
    });

    expect(stackFrames(intact)).toEqual(['handOff lib/channel/proactive/queue.ts:10']);
    expect(stackFrames(reworded)).toEqual([]);
    expect(stackFrames(blanked)).toEqual([]);
  });

  it('carries at most the bound of frames, and none for a value that is not an error', () => {
    const err = caught(() => throwsDeep(STACK_FRAMES + 4)) as Error;
    expect(err.stack?.split('\n').filter((line) => /^\s+at /.test(line)).length).toBeGreaterThan(
      STACK_FRAMES,
    );
    expect(stackFrames(err)).toHaveLength(STACK_FRAMES);
    expect(stackFrames('not an error')).toEqual([]);
  });
});
