import { describe, expect, it } from 'vitest';
import { rushSignal } from './rush';

describe('rushSignal', () => {
  it('names a waiting room, resident verification, and a timed open', () => {
    expect(rushSignal('You are in the queue. Waiting room is full.')).toBe('waiting_room');
    expect(rushSignal('Enter your resident ID to verify your residency.')).toBe(
      'resident_verification',
    );
    expect(rushSignal('Registration opens at 7:00am.')).toBe('timed_open');
  });

  it('leaves an ordinary private booking alone', () => {
    expect(rushSignal('Saturday swim lesson. Choose a class time.')).toBeNull();
    expect(rushSignal('The pool opens at 9:00am.')).toBeNull();
  });
});
