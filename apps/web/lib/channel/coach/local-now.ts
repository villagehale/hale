/** Today's date, weekday and time as the family reads them on their own clock. */
export function familyLocalNow(
  now: Date,
  timeZone: string,
): { date: string; weekday: string; time: string; timeZone: string } {
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, ...opts }).format(now);
  return {
    date: part({ year: 'numeric', month: '2-digit', day: '2-digit' }),
    weekday: part({ weekday: 'long' }),
    time: part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    timeZone,
  };
}
