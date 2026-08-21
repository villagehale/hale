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
 * use unrestricted) rendered at a 1056px cap, dilated to the founder-approved marker weight,
 * with the RAW glyphs’ enclosed counters eroded and punched back through before the
 * trace — the first cut sealed the bowls of ‘a’ and ‘e’ at lockup size (founder
 * caught it on the poster). Thick strokes AND open counters, verified at 48px. Upright, because the hand already is; no slant was added.
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
        viewBox="0 0 1391.000000 1055.000000"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <g transform="translate(0.000000,1055.000000) scale(0.100000,-0.100000)">
          <path d="M1 7913 c1 -1451 4 -2627 6 -2613 17 89 89 205 182 293 l61 58 0 2103 c0 2279 -3 2154 52 2236 13 19 39 43 58 54 33 20 51 21 265 21 258 0 304 -8 433 -71 168 -82 267 -248 301 -505 27 -197 33 -476 61 -2604 6 -418 13 -821 16 -895 l7 -136 86 8 c710 65 1115 109 1426 153 208 30 624 101 631 108 8 8 -63 1133 -96 1527 -66 776 -124 1210 -239 1765 -68 331 -82 448 -88 736 -5 232 -4 248 15 291 23 52 51 71 139 92 50 13 -164 14 -1629 15 l-1688 1 1 -2637z M3774 10539 c260 -38 431 -153 503 -337 131 -333 276 -1263 418 -2674 40 -402 84 -866 100 -1073 l7 -80 226 0 c213 0 229 -1 267 -21 83 -45 134 -123 156 -240 15 -79 5 -402 -14 -469 -48 -170 -142 -266 -338 -343 -41 -17 -110 -38 -153 -49 l-79 -18 7 -125 c50 -995 64 -1583 73 -3017 6 -1045 5 -1116 -12 -1178 -24 -90 -63 -141 -133 -173 -52 -24 -71 -26 -209 -30 -320 -9 -540 39 -716 155 -119 79 -204 209 -226 344 -7 42 -12 710 -13 1951 -2 1037 -5 1889 -8 1891 -3 3 -68 -3 -145 -13 -557 -74 -1249 -139 -1717 -160 -134 -7 -258 -14 -277 -17 l-34 -5 7 -411 c17 -1054 61 -2237 102 -2722 35 -416 45 -967 20 -1043 -20 -59 -82 -122 -142 -143 -53 -19 -439 -19 -544 0 -197 35 -386 120 -491 218 -80 76 -95 109 -109 248 -37 375 -50 1002 -50 2501 l0 1341 -50 7 c-92 12 -153 49 -181 110 -18 40 -19 -13 -19 -2461 l0 -2503 5173 1 c2844 1 5151 5 5125 9 -247 42 -473 240 -650 570 -117 218 -233 601 -312 1030 -48 263 -71 451 -111 910 -79 917 -95 1283 -102 2450 -8 1339 17 2233 102 3570 13 212 27 455 30 540 21 556 54 923 92 1045 38 120 88 185 158 204 58 16 327 13 406 -3 110 -24 194 -71 284 -161 87 -86 123 -148 151 -255 19 -77 15 -422 -9 -720 -9 -107 -21 -296 -27 -420 -27 -570 -31 -673 -45 -940 -75 -1481 -65 -2893 30 -4260 82 -1185 235 -2083 420 -2473 28 -58 43 -78 74 -95 64 -36 164 -153 214 -250 68 -131 77 -173 77 -341 0 -132 -2 -151 -24 -196 -47 -102 -170 -177 -334 -205 -26 -4 681 -8 1571 -9 l1617 -1 -1 848 c-1 530 -5 827 -10 794 -14 -84 -56 -198 -110 -302 -195 -371 -551 -671 -917 -771 -98 -27 -407 -37 -562 -20 -261 31 -470 129 -670 317 -346 326 -566 902 -656 1719 -22 191 -31 910 -14 1129 41 559 151 1070 316 1465 194 461 484 762 823 853 109 29 436 37 569 14 384 -67 663 -364 759 -808 26 -120 26 -524 0 -653 -102 -511 -470 -1131 -912 -1536 -105 -96 -258 -212 -341 -259 -33 -18 -60 -34 -61 -35 -7 -4 52 -311 87 -452 54 -215 108 -371 181 -522 48 -99 73 -137 119 -183 32 -32 63 -58 70 -58 6 0 33 22 60 49 55 55 105 148 162 301 44 119 130 294 193 390 23 36 68 88 100 115 l58 50 166 0 166 0 68 -33 c156 -77 301 -231 342 -365 11 -35 14 675 14 4231 l1 4272 -5097 -1 c-2903 -1 -5073 -5 -5039 -10z m3716 -4299 c96 -26 191 -123 258 -261 l37 -77 103 -25 c199 -50 337 -139 397 -257 49 -96 56 -178 54 -565 l-3 -350 33 -135 c49 -204 97 -474 120 -675 21 -177 32 -275 111 -980 21 -193 46 -409 55 -480 20 -162 185 -1184 225 -1399 25 -133 30 -184 30 -313 0 -85 -5 -175 -11 -200 -16 -60 -64 -108 -131 -128 -61 -18 -345 -21 -447 -4 -204 33 -317 123 -420 334 -63 127 -91 221 -138 456 l-37 189 -29 -53 c-239 -429 -470 -682 -741 -812 -151 -72 -197 -80 -456 -80 -248 0 -299 8 -414 67 -257 129 -415 401 -483 828 -25 160 -25 776 0 1020 100 966 411 2046 836 2905 172 347 307 564 496 799 95 119 155 172 214 190 54 17 288 21 341 6z M7141 4405 c-277 -723 -459 -1675 -476 -2495 l-5 -215 34 70 c159 328 348 1116 435 1815 40 322 75 778 69 900 l-3 65 -54 -140z M12368 4997 c-93 -162 -187 -443 -242 -722 -26 -133 -44 -257 -36 -248 22 23 128 202 179 303 65 128 102 228 125 340 20 100 28 240 19 323 l-8 69 -37 -65z" />
        </g>
      </svg>
      <span className="sr-only" translate="no">
        Hale
      </span>
    </>
  );
}
