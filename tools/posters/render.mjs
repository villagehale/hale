// The neighborhood poster renderer — the exact template that cut the 2026-08-26
// Toronto pack (hale-toronto-posters.pdf) and, before it, the Georgetown/Acton
// plates: the shore portrait, the icon+wordmark lockup, the serif headline, the
// frosted neighborhood card, the amber banner, the navy scan card. One plate is
// one entry in plates.mjs; nothing about the chrome is configurable per plate
// beyond the three things a neighborhood changes — the band, the local sentence,
// and the QR payload.
//
// Assets are the live ones: the wordmark path is read out of the shipped site
// component so the mark can never drift from the header's, the icon is the site
// favicon, the fonts are the site's own woff2 files. Only the portrait shore art
// lives here (assets/shore-portrait.png) — the site ships a wide crop; print
// needs the portrait master.
//
// Usage: node tools/posters/render.mjs <code> — writes print/<code>.{html,pdf,png}.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PLATES } from './plates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const requireSite = createRequire(join(REPO, 'apps/site/package.json'));
const requireRoot = createRequire(join(REPO, 'package.json'));
const { encode } = requireSite('uqr');
const { chromium } = requireRoot('playwright');

const NAVY = '#17294a';
const AMBER = '#b26b1f';
const SLATE = '#41546f';
const FONTS = join(REPO, 'apps/site/app/fonts');
const SMS_DISPLAY = '+1 (289) 217-2279';

const wm = readFileSync(join(REPO, 'apps/site/components/wordmark.tsx'), 'utf8');
const wmViewBox = wm.match(/viewBox="([^"]+)"/)[1];
const wmTransform = wm.match(/transform="([^"]+)"/)[1];
const wmPath = wm.match(/<path d="([^"]+)"/)[1];

function wordmarkSvg(widthIn) {
  return `<svg viewBox="${wmViewBox}" style="width:${widthIn}in;height:auto" fill="${NAVY}"><g transform="${wmTransform}"><path d="${wmPath}"/></g></svg>`;
}

function qrSvg(value, sizeIn, ecc = 'M') {
  const { size: modules, data } = encode(value, { ecc, border: 2 });
  let path = '';
  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${modules} ${modules}" style="width:${sizeIn}in;height:${sizeIn}in;border-radius:8px" shape-rendering="crispEdges"><rect width="${modules}" height="${modules}" fill="#ffffff"/><path d="${path}" fill="${NAVY}"/></svg>`;
}

function platePage(plate) {
  return `
  <section class="page poster">
    <div class="lockup">
      <img class="icon" src="file://${join(REPO, 'apps/site/app/icon.png')}" alt="">
      ${wordmarkSvg(0.95)}
    </div>
    <div class="phonetic">/HAH-LEH/ · HAWAIIAN FOR HOME</div>

    <h1>The family assistant<br>you&nbsp;text.</h1>
    <p class="subhead">It takes the family admin off your&nbsp;plate.</p>
    <p class="body">Toronto rec, swim and camp registration — caught before it fills.<br>Your week, planned. Nothing without your say-so.</p>

    <div class="card">
      <div class="eyebrow">For ${plate.band} families</div>
      <div class="cardtitle">Gone by 7:02 a.m.? Not&nbsp;anymore.</div>
      <p class="cardbody">${plate.localLine}</p>
    </div>

    <div class="banner">No app to install — Hale lives in your texts. Free to start.</div>

    <div class="qrcard">
      ${qrSvg(plate.qrValue, 2.0, plate.qrEcc)}
      <div class="qrcopy">
        <div class="scan">${plate.scan?.title ?? 'Scan to text Hale'}</div>
        <p class="hint">${plate.scan?.hint ?? 'Point your phone camera at the code — it opens a text to Hale, already started.'}</p>
        <span class="pill">${plate.scan?.site ?? `or text ${SMS_DISPLAY}`}</span>
      </div>
    </div>
  </section>`;
}

function html(plate) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Source Serif 4'; src: url('file://${FONTS}/source-serif-4-latin-wght-normal.woff2') format('woff2'); font-weight: 400 700; }
  @font-face { font-family: 'Figtree'; src: url('file://${FONTS}/figtree-latin-wght-normal.woff2') format('woff2'); font-weight: 300 900; }
  @page { size: letter; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Figtree', sans-serif; color: ${NAVY}; }
  .page { width: 8.5in; height: 11in; page-break-after: always; overflow: hidden; position: relative; }

  .poster { background: url('file://${join(HERE, 'assets/shore-portrait.png')}') center / cover no-repeat; padding: 0.52in 0.75in 0.3in; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .lockup { display: flex; align-items: center; gap: 0.16in; }
  .icon { width: 0.62in; height: 0.62in; border-radius: 0.14in; }
  .phonetic { margin-top: 0.14in; font-size: 10.5pt; font-weight: 600; letter-spacing: 0.28em; color: ${NAVY}; }

  h1 { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 38pt; line-height: 1.12; margin-top: 0.34in; }
  .subhead { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 20pt; margin-top: 0.2in; }
  .body { font-size: 12.5pt; line-height: 1.55; margin-top: 0.16in; color: ${SLATE}; }

  .card { background: rgba(255,255,255,0.78); border-radius: 14px; padding: 0.26in 0.42in; margin-top: 0.34in; width: 6.9in; }
  .eyebrow { font-size: 10.5pt; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: ${AMBER}; }
  .cardtitle { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 27pt; margin-top: 0.1in; }
  .cardbody { font-size: 12pt; line-height: 1.5; margin-top: 0.1in; color: ${SLATE}; max-width: 5.9in; margin-left: auto; margin-right: auto; }

  .banner { background: ${AMBER}; color: #ffffff; font-weight: 700; font-size: 13pt; border-radius: 10px; padding: 0.14in 0.3in; margin-top: 0.28in; width: 6.9in; }

  .qrcard { background: ${NAVY}; border-radius: 18px; padding: 0.3in; margin-top: 0.34in; width: 6.6in; display: flex; align-items: center; gap: 0.32in; text-align: left; }
  .qrcopy .scan { font-family: 'Source Serif 4', Georgia, serif; font-weight: 600; font-size: 23pt; color: #ffffff; }
  .qrcopy .hint { font-size: 11.5pt; line-height: 1.45; color: rgba(255,255,255,0.85); margin-top: 0.08in; }
  .pill { display: inline-block; background: ${AMBER}; color: #ffffff; font-weight: 700; font-size: 11.5pt; border-radius: 999px; padding: 0.07in 0.2in; margin-top: 0.14in; }
</style></head><body>${platePage(plate)}</body></html>`;
}

const code = process.argv[2];
const plate = PLATES.find((p) => p.code === code);
if (!plate) {
  console.error(`unknown plate '${code}'. Known: ${PLATES.map((p) => p.code).join(', ')}`);
  process.exit(1);
}

mkdirSync(join(HERE, 'print'), { recursive: true });
const out = plate.outName ?? plate.code;
const htmlPath = join(HERE, 'print', `${out}.html`);
writeFileSync(htmlPath, html(plate));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 300 / 96 });
await page.goto(`file://${htmlPath}`);
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: join(HERE, 'print', `${out}.pdf`),
  format: 'Letter',
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});
await page.locator('.page').screenshot({ path: join(HERE, 'print', `${out}.png`) });
await browser.close();
console.log(`cut ${plate.code}: print/${out}.{html,pdf,png}`);
