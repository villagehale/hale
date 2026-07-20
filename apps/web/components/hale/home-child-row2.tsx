import Link from 'next/link';
import { Mascot } from '~/components/hale/mascot';
import { formatDurationMinutes } from '~/lib/format/datetime';
import type { HomeChildDays } from '~/lib/home/child-days';

/**
 * Home Row 2 (design handoff §4.2): today's highlights / sleep mini-chart / meals for
 * the ACTIVE child. Every value is a real logged aggregate from `day` (server-derived,
 * teen-redacted) — the prototype's fixed bar heights and canned meal times are sample
 * data and are NOT reproduced. Each card carries an honest empty state when the child
 * has nothing logged. Rendered under Row 1 by the shared-selection surface.
 */
export function HomeChildRow2({ day, childName }: { day: HomeChildDays; childName: string }) {
  return (
    <div className="home-row2">
      <TodaysHighlights day={day} childName={childName} />
      <SleepCard day={day} />
      <MealsCard day={day} />
    </div>
  );
}

function TodaysHighlights({ day, childName }: { day: HomeChildDays; childName: string }) {
  return (
    <div className="rise rise-3 home-col">
      <p className="eyebrow text-faded-sage">today&rsquo;s highlights</p>
      <div className="card home-card-fill">
        {day.highlights.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {day.highlights.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow text-faded-sage">{item.kindLabel}</p>
                  <p className="mt-0.5 leading-snug text-spruce" data-hale-pii>
                    {item.summary}
                  </p>
                </div>
                <span className="tabular meta shrink-0 text-faded-sage">{item.time}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-spruce leading-relaxed">
            nothing logged for <span data-hale-pii>{childName}</span> today yet — a feed, nap or
            milestone shows up here.
          </p>
        )}
      </div>
    </div>
  );
}

function SleepCard({ day }: { day: HomeChildDays }) {
  const max = Math.max(...day.sleepWeek);
  const hasWeekSleep = max > 0;
  // Today leads; on a today-less-but-logged week the average carries the headline so
  // the number is never a bare "0m".
  const headlineMin = day.todaySleepMin > 0 ? day.todaySleepMin : (day.avgSleepMin ?? 0);
  const headlineLabel = day.todaySleepMin > 0 ? 'logged today' : 'avg / day this week';

  return (
    <div className="rise rise-4 home-col">
      <p className="eyebrow text-faded-sage">sleep</p>
      <div className="card home-card-fill">
        {hasWeekSleep ? (
          <>
            <p className="tabular font-display text-[1.75rem] leading-none text-spruce">
              {formatDurationMinutes(headlineMin)}
            </p>
            <p className="meta mt-1 text-faded-sage">{headlineLabel}</p>
            {/* Decorative glance — the numbers above/right carry the same values for a
                screen reader (chart is aria-hidden). */}
            <div className="sleep-chart mt-4" aria-hidden>
              {day.sleepWeek.map((min, i) => (
                <div
                  // Fixed 7-slot week; index is the stable position (oldest→newest).
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional, not identity
                  key={i}
                  className="sleep-bar-col"
                >
                  <div
                    className="sleep-bar-fill"
                    style={{ height: `${min > 0 ? Math.max(6, Math.round((min / max) * 100)) : 0}%` }}
                  />
                </div>
              ))}
            </div>
            <p className="meta mt-2 flex justify-between text-faded-sage">
              <span>last 7 days</span>
              <span>today</span>
            </p>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-4 text-center">
            <Mascot pose="swim" size={72} />
            <p className="text-spruce leading-relaxed">log sleep to see your week.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MealsCard({ day }: { day: HomeChildDays }) {
  return (
    <div className="rise rise-5 home-col">
      <p className="eyebrow text-faded-sage">meals</p>
      <div className="card home-card-fill">
        {day.mealsToday > 0 ? (
          <>
            <p className="tabular font-display text-[1.75rem] leading-none text-spruce">
              {day.mealsToday}
            </p>
            <p className="meta mt-1 text-faded-sage">
              {day.mealsToday === 1 ? 'meal logged today' : 'meals logged today'}
            </p>
            <ul className="mt-4 flex flex-col gap-2">
              {day.meals.map((meal) => (
                <li key={meal.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 leading-snug text-spruce" data-hale-pii>
                    {meal.summary}
                  </span>
                  <span className="tabular meta shrink-0 text-faded-sage">{meal.time}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-spruce leading-relaxed">
            no meals logged today —{' '}
            <Link href="/companion" className="link">
              log a feed
            </Link>{' '}
            to track the day.
          </p>
        )}
      </div>
    </div>
  );
}
