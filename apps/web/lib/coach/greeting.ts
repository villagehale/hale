/**
 * The Ask empty-state greeting (desktop handoff §4.4: "Good evening, {parentName}.").
 * A time-of-day word by the LOCAL hour, so the greeting is computed on the client and
 * kept pure + injectable here so the boundary hours are unit-tested (never derived
 * from the current clock in a test). Morning < 12:00 ≤ afternoon < 18:00 ≤ evening.
 */
export function timeOfDayGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The full greeting line: "Good evening, Alex." when the parent's first name is known,
 * else just the time-of-day greeting. Pronoun-safe (interpolates the real name only,
 * never a gendered form).
 */
export function greetingLine(firstName: string | null, date: Date): string {
  const greeting = timeOfDayGreeting(date);
  return firstName ? `${greeting}, ${firstName}.` : `${greeting}.`;
}
