import type { ReactElement } from 'react';

/**
 * The Hale wordmark, as drawn art rather than set type.
 *
 * The name was set in the display face — Bellefair 400, tracked open — which made
 * it a string the browser laid out: it re-flowed with the type stack, it needed the
 * one Bellefair rule that sat OUTSIDE the locale allowlist (there is no Chinese
 * spelling of "Hale" for the allowlist to protect), and its stroke was thin enough
 * that #506's stem gate had to step it to 1.65rem just to stop it reading lighter
 * than the nav links beside it. A logo should not be renegotiated by a font stack.
 *
 * This is that same name drawn once and frozen: Just Another Hand (Apache-2.0, logo
 * use unrestricted) rendered at a 1056px cap, dilated by the square MaxFilter(7) the
 * founder approved in the comps — reproduced by RATIO, radius/em 0.009375, so it is
 * the approved weight and not merely a heavier one — then traced with potrace to a
 * single path. Upright, because the hand already is; no slant was added.
 *
 * `fill="currentColor"` is the whole theming story. The traced file shipped
 * `fill="#000000"`, which would have painted a black mark on the navy dark ground;
 * inheriting `color` instead means the mark is navy in light, cream in dark, and
 * amber nowhere, with no second copy of the art.
 *
 * The SVG is decorative and the NAME travels beside it. In the header, the footer
 * and the legal masthead the lockup is an `<a aria-label="Hale, home">`, whose label
 * already wins over any descendant text — but the landing's closing card and the
 * QR-entry page are NOT links, and there the visible word was the only "Hale" in the
 * accessibility tree. Art alone would have deleted it. So the mark always carries
 * its own `sr-only` name: redundant inside the three anchors, load-bearing in the
 * other two.
 */
export function Wordmark({ className }: { className?: string }): ReactElement {
  return (
    <>
      <svg
        className={className === undefined ? 'wordmark' : `wordmark ${className}`}
        viewBox="0 0 1498.41 1138.88"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M356.11 1.5c-7.4 1.6-11.7 3.9-14.6 7.8-2 2.8-2.1 3.8-2 36 0 39.4.4 43 10.4 92.7 3.8 19 8.1 41.5 9.5 50 4.6 28.9 12.1 98.1 16 148 3.3 42.5 9 137.8 8.3 138.5-1.2 1.2-52.9 9.9-82.8 13.9-10.2 1.4-41.4 4.8-69.5 7.6-28 2.7-54.8 5.4-59.5 5.9-4.7.4-8.6.8-8.7.7-.5-.4-2.4-108.3-3.3-188.1-1.6-142.6-2.9-183.9-6.1-204.5-3-19.3-8.6-31.7-18.8-41.2-15-14.2-32.1-18.4-71.6-17.6-17.4.3-19.4.5-23.7 2.6-5.7 2.8-8.4 6.4-10.9 14.4-1.8 5.8-1.9 14.2-1.9 231.5v225.6l-6.5 5.9c-7.5 6.9-14.7 17.3-17.6 25.5-1.7 4.7-2.2 9-2.6 22.5-.6 19.6 0 26.5 3 30.9 2.8 4.1 9.5 7.6 17.5 9.1l6.2 1.2v143.5c0 79 .5 159.1 1 178.1 1.6 57.5 3.8 93.5 6.2 102.5 4 15.3 29.5 30.9 60.8 37.1 11.1 2.2 55.9 3.2 64.3 1.4 8.4-1.7 14.5-6.3 18.2-13.4 3-5.9 3-6.1 3.4-25.2.4-23.9-1.2-59.5-4.4-99.9-4.2-51.5-7.2-133.6-11.1-298.6l-.6-27.6 15.8-.7c54.2-2.3 102.8-6.5 172.7-14.7 19.2-2.2 35.1-3.8 35.5-3.4s.9 93 1.2 205.8l.5 205.2 2.3 6.6c6.2 18.4 21.5 32.4 43.7 39.8 15.3 5.1 23.8 6.1 53.1 6.1 27.9 0 32.1-.6 38.7-5.2 6.1-4.4 10.1-14.2 11.2-27.8.8-9.4-1.2-237.7-2.5-291-1.2-47.6-2.5-84.6-4.6-127.9-.8-17.7-1.4-32.4-1.2-32.5.2-.2 4.3-1.3 9.2-2.6 22.7-5.9 38.1-15 45.3-27.2 5.9-9.7 7.5-18.4 8-43.5.6-24.6-.2-32.2-4.4-41.6-3.3-7.2-9.7-13.2-16.6-15.2-3.8-1.1-10.5-1.5-27.3-1.5h-22.1l-.7-9.3c-1.9-25.3-10.8-117.6-15.7-161.7-14.9-135.7-29.4-219.3-42.6-245.4-3.2-6.3-12.2-15.3-19.3-19.3-7.5-4.3-18.8-7.9-30.1-9.8-12.3-2-49.6-2-58.7 0m661.4 23.7c-8.1 2.2-14.6 12.8-18.1 29.4-2.8 13.4-6.3 59.2-8 105.4-.3 8.5-1.7 32.8-3 54-5.2 82-6.8 115.4-9.7 200-1.7 50.1-1.7 263.5 0 306 2.3 56.5 3.9 83.1 8.8 140 7 83.5 13.9 125 29 174.6 14.2 47 39.4 83.3 67.3 97 12.1 5.9 16.2 6.6 42.6 7.1 21.1.4 25.1.2 33.6-1.5 11.7-2.4 19.9-6.2 26.2-12.1 8.6-8 9.1-9.7 9.5-32.2.4-23.1-.4-27.5-7.4-41.6-5.6-11.2-13.9-21.3-22.2-27.1-6.9-4.9-8.1-6.8-14.3-22.5-15.9-41-30.5-127.4-38.4-228.2-7-90.4-9.9-168.7-9.9-272 0-88.4 1.1-130.6 5.9-221 .8-15.4 2.2-43.3 3-62 1.9-42.9 3.1-62.9 5.1-82.5 1.1-11.1 1.5-22.3 1.2-39.5-.4-23-.5-24.3-3-31.4-6.5-17.9-21.3-32.2-39.8-38.3-5.8-1.9-9.1-2.2-30.5-2.4-14.8-.2-25.5.1-27.9.8m-251.1 437.2c-2.2.7-6 2.5-8.3 4.1-4.1 2.7-19.7 21-27.2 32-1.9 2.7-4 5.6-4.7 6.3-1.8 1.8-16.6 25.8-23.5 38.2-20.3 36-42.5 88.9-60.7 144.4-21 64.1-34.5 125.6-41.8 190.6-2.6 23.4-2.6 105.5 0 122 5.5 34.2 15.1 55.7 32.6 73 10.8 10.7 18.5 15.4 31.6 19.2 7.5 2.2 9.6 2.3 36.5 2.3 26.2-.1 29.2-.3 36.5-2.3 16.3-4.5 34.1-15.2 50.1-30.4 12.4-11.7 29.6-34.2 38.7-50.8l3.5-6.2.7 3.3c5.5 28.3 9.9 42.9 17.1 56.9 8.8 17.2 18 25.6 33.4 30.7l8.5 2.8h29c28 0 29.1-.1 33.1-2.2 5.2-2.8 9-7.2 10.4-12.1.5-2 1-13.7 1-25.9 0-19.3-.3-23.7-2.4-34.5-1.3-6.7-7-40.2-12.5-74.3-9.8-60.6-13.4-86.3-18.6-135-1.4-13.2-3.4-31-4.5-39.5s-3.1-26.5-4.5-40c-3.9-38.2-7.2-58.3-15-93l-3.8-16.5.2-37.5c.2-40.8-.4-47.9-5.3-58.6-5.9-12.9-20.9-22.9-42.7-28.3l-11.1-2.8-3.8-7.7c-6.3-12.7-14.2-22-22.5-26.4-4.9-2.6-5.4-2.7-25.5-2.9-14.5-.2-21.7.1-24.5 1.1m-9 289.2c-3.1 21.6-7.6 47.7-11.6 67.4-4.6 22.1-13.3 56.8-13.7 54.3-.2-1.3.6-9.1 1.8-17.5a889 889 0 0 1 19.5-100.7c3-11.8 5.5-21.6 5.5-21.9s.2-.3.5 0-.6 8.6-2 18.4m550.3-268.5c-21 3.1-38.3 12-56.1 28.8-42.7 40.6-70.1 122.9-76.8 230.6-1.5 24.2-.6 90.7 1.5 113.5 7.3 78 27.6 140 57.7 176.5 21.8 26.5 47.2 42.1 77.4 47.7 4.8.9 16.6 1.3 37 1.3 29.2-.1 30.2-.1 39.6-2.7 41.4-11.3 80.6-45.5 100.9-88 8.8-18.5 9.5-22.3 9.5-52.3v-26l-3.2-6.5c-6.5-13.2-19.9-26.2-34.2-33.3l-6.5-3.2-21-.3c-11.5-.2-21.9-.1-23.1.2-1.3.3-5.4 3.5-9.2 7.1-5.8 5.3-8.3 8.8-14.8 20.5-4.3 7.8-10.5 21-13.7 29.3-7.4 19.3-11.2 26.8-16.4 32.6l-4.2 4.6-3.6-3.8c-13.5-14.4-28.6-55.6-37.1-101.2-2.4-13-2.5-14.1-.9-15 38.2-22.8 75.4-61.9 102.5-107.7 8-13.4 20-37.9 25.4-51.7 4.6-12 10-32.9 11.4-44.6 1.7-13.8 1.4-50.8-.5-63.4-7.3-49.2-39.2-85.1-82.1-92.6-9.4-1.7-49.2-1.9-59.5-.4" />
      </svg>
      <span className="sr-only" translate="no">
        Hale
      </span>
    </>
  );
}
