'use client';

import { useState } from 'react';
import { checkpointForMonths } from '~/lib/milestones/index';

/**
 * Optional birth-month/year helper. It computes age in months ENTIRELY in the
 * browser and navigates to the checkpoint at or below that age (never rounding
 * up — that would show an older child's list and manufacture false worry). The
 * birthday is never sent, stored, or logged: no fetch, no analytics event, no
 * cookie. That "stays on this device" promise is load-bearing brand trust and
 * must remain technically true, so this is the only place the DOB is read and it
 * leaves only as a same-origin route change to a static age page.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function ageInMonths(birthYear: number, birthMonth: number, now: Date): number {
  return (now.getFullYear() - birthYear) * 12 + (now.getMonth() - birthMonth);
}

export function BirthdayHelper() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => currentYear - i);

  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');

  function show() {
    if (month === '' || year === '') return;
    const months = ageInMonths(Number(year), Number(month), now);
    const target = checkpointForMonths(Math.max(0, months));
    window.location.href = `/milestones/${target.slug}`;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3">
        <label className="sr-only" htmlFor="birth-month">
          Birth month
        </label>
        {/* autoComplete off (not bday-*): this is the CHILD's birth month, and
            bday-* would offer the account holder's own birthday — wrong here, and
            at odds with the "stays on this device, nothing stored" promise. */}
        <select
          id="birth-month"
          name="birth-month"
          autoComplete="off"
          className="field"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          <option value="">Month</option>
          {MONTHS.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="birth-year">
          Birth year
        </label>
        <select
          id="birth-year"
          name="birth-year"
          autoComplete="off"
          className="field"
          value={year}
          onChange={(e) => setYear(e.target.value)}
        >
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={show}
          className="btn-secondary shrink-0"
          disabled={month === '' || year === ''}
        >
          Show me this age
        </button>
      </div>
      <p className="meta mt-3" style={{ lineHeight: 1.5 }}>
        Stays on this device. We don’t send, store, or track your child’s birthday.
      </p>
    </div>
  );
}
