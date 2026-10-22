import { describe, expect, it } from 'vitest';
import { rushOpensAt, rushSignal } from './rush';

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

  it('reads the open time the page states', () => {
    expect(rushOpensAt('Registration opens at 7:00am.')).toBe('7:00am');
    expect(rushOpensAt('Registration opens on Monday, January 5 at 7:00 AM EST')).toBe(
      'Monday, January 5 at 7:00 AM',
    );
    expect(rushOpensAt('You are in the queue.')).toBeNull();
  });
});
