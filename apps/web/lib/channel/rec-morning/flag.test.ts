import { describe, expect, it } from 'vitest';
import { REC_MORNING_MODEL_TOPIC_ENABLED_ENV, recMorningModelTopicEnabled } from './flag';

describe('recMorningModelTopicEnabled', () => {
  it('is on only when the value is exactly true', () => {
    expect(recMorningModelTopicEnabled({})).toBe(false);
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: '' })).toBe(false);
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: 'on' })).toBe(
      false,
    );
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: '1' })).toBe(false);
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: 'TRUE' })).toBe(
      false,
    );
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: 'true\n' })).toBe(
      false,
    );
    expect(recMorningModelTopicEnabled({ [REC_MORNING_MODEL_TOPIC_ENABLED_ENV]: 'true' })).toBe(
      true,
    );
  });
});
