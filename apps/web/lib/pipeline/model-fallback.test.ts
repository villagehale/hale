import { describe, expect, it, vi } from 'vitest';
import { recordModelFallback } from './model-fallback';

describe('recordModelFallback', () => {
  it('logs a content-free error category and cumulative fallback count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    recordModelFallback(
      'test candidate',
      new Error('AI_GATEWAY_API_KEY is not set; private parent text must not be logged'),
    );

    expect(warn).toHaveBeenCalledWith(
      { errorCategory: 'missing_key', fallbackCount: 1 },
      'test candidate: using current model',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private parent text');
    warn.mockRestore();
  });
});
