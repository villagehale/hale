#!/usr/bin/env node
/**
 * Render one neighborhood poster plate to HTML + PNG + PDF.
 *
 * Usage: node tools/posters/render.mjs [plate-id]
 * Default plate: earlyon-ossington
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, displaySmsNumber, plateFor, smsHref } from './plates.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PRINT = join(ROOT, 'print');
const CHROME_BIN = process.env.CHROME_PATH ?? 'google-chrome';

function qrSvg(href) {
  const script = `
import qrcode, qrcode.image.svg, sys
img = qrcode.make(sys.argv[1], image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
sys.stdout.buffer.write(img.to_string())
`;
  const result = spawnSync('python3', ['-c', script, href], {
    encoding: 'buffer',
    maxBuffer: 2_000_000,
  });
  if (result.status !== 0) {
    throw new Error(`qrcode failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString('utf8');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function posterHtml(plate) {
  const href = smsHref(plate.sourceCode);
  const phone = displaySmsNumber();
  const qr = qrSvg(href);
  // Paths are relative to tools/posters/print/*.html so the plate is portable.
  const shore = '../assets/shore-portrait.png';
  const logo = '../../../apps/site/assets/hale-logo.jpeg';
  const fontFace = `
    @font-face { font-family: Figtree; font-style: normal; font-weight: 100 900; src: url('../../../apps/site/app/fonts/figtree-latin-wght-normal.woff2') format('woff2'); }
    @font-face { font-family: Fraunces; font-style: normal; font-weight: 100 900; src: url('../../../apps/site/app/fonts/fraunces-latin-opsz-wght-normal.woff2') format('woff2'); }
  `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hale · ${escapeHtml(plate.neighborhood)}</title>
<style>
  ${fontFace}
  @page { size: 11in 17in; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 11in;
    height: 17in;
    background: #f4d27a url('${shore}') center / cover no-repeat;
    color: #17294a;
    font-family: Fraunces, 'Iowan Old Style', Georgia, serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    box-sizing: border-box;
    height: 17in;
    padding: 0.62in 0.7in 0.55in;
    display: flex;
    flex-direction: column;
  }
  .push-band { flex: 0.55; }
  .push-footer { flex: 1; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.16in;
  }
  .brand img {
    width: 0.62in;
    height: 0.62in;
    border-radius: 30%;
    display: block;
  }
  .wordmark {
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 800;
    font-size: 0.52in;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .pronounce {
    margin: 0.14in 0 0;
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 700;
    font-size: 0.13in;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0.28in 0 0;
    font-weight: 700;
    font-size: 0.58in;
    line-height: 1.02;
    letter-spacing: -0.03em;
  }
  .sub {
    margin: 0.12in 0 0;
    font-weight: 700;
    font-size: 0.28in;
    line-height: 1.15;
  }
  .lede {
    margin: 0.2in 0 0;
    font-weight: 600;
    font-size: 0.195in;
    line-height: 1.28;
    max-width: 8.6in;
  }
  .lede p { margin: 0 0 0.06in; }
  .band {
    margin: 0.42in auto 0;
    width: 8.55in;
    box-sizing: border-box;
    background: rgb(255 255 255 / 0.88);
    border-radius: 0.18in;
    padding: 0.28in 0.36in 0.3in;
    text-align: center;
  }
  .band-label {
    margin: 0;
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 700;
    font-size: 0.135in;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #b26b1f;
  }
  .band h2 {
    margin: 0.1in 0 0;
    font-weight: 700;
    font-size: 0.34in;
    line-height: 1.1;
    letter-spacing: -0.02em;
  }
  .band p {
    margin: 0.12in auto 0;
    max-width: 7.4in;
    font-weight: 600;
    font-size: 0.175in;
    line-height: 1.32;
  }
  .cta {
    margin: 0.32in 0 0;
    background: #c47a28;
    color: #fff;
    border-radius: 0.14in;
    text-align: center;
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 700;
    font-size: 0.195in;
    letter-spacing: 0.01em;
    padding: 0.2in 0.28in;
  }
  .grow { flex: 1; }
  .footer {
    margin-top: 0.28in;
    background: #17294a;
    color: #fff;
    border-radius: 0.2in;
    display: flex;
    align-items: center;
    gap: 0.32in;
    padding: 0.28in 0.32in;
  }
  .qr-plate {
    flex: 0 0 2.05in;
    width: 2.05in;
    height: 2.05in;
    background: #fff;
    border-radius: 0.1in;
    padding: 0.1in;
    box-sizing: border-box;
  }
  .qr-plate svg { width: 100%; height: 100%; display: block; }
  .scan h3 {
    margin: 0;
    font-weight: 700;
    font-size: 0.4in;
    line-height: 1.05;
    letter-spacing: -0.02em;
  }
  .scan p {
    margin: 0.1in 0 0;
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 700;
    font-size: 0.155in;
    line-height: 1.3;
    color: rgb(255 255 255 / 0.88);
    max-width: 6.4in;
  }
  .phone {
    display: inline-block;
    margin-top: 0.16in;
    background: #c47a28;
    color: #fff;
    border-radius: 0.1in;
    font-family: Figtree, 'Avenir Next', sans-serif;
    font-weight: 700;
    font-size: 0.175in;
    padding: 0.1in 0.2in;
  }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div class="brand">
        <img src="${logo}" alt="">
        <div class="wordmark">Hale</div>
      </div>
      <p class="pronounce">${escapeHtml(CHROME.pronunciation)}</p>
      <h1>${escapeHtml(CHROME.headline)}</h1>
      <p class="sub">${escapeHtml(CHROME.subhead)}</p>
      <div class="lede">
        ${CHROME.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
      </div>
    </header>
    <div class="push-band"></div>
    <section class="band">
      <p class="band-label">${escapeHtml(plate.neighborhood)}</p>
      <h2>${escapeHtml(plate.bandHeadline)}</h2>
      <p>${escapeHtml(plate.bandBody)}</p>
    </section>
    <div class="cta">${escapeHtml(CHROME.cta)}</div>
    <div class="push-footer"></div>
    <footer class="footer">
      <div class="qr-plate" data-sms="${escapeHtml(href)}">${qr}</div>
      <div class="scan">
        <h3>${escapeHtml(CHROME.scanTitle)}</h3>
        <p>${escapeHtml(CHROME.scanHelp)}</p>
        <div class="phone">or text ${escapeHtml(phone)}</div>
      </div>
    </footer>
  </div>
</body>
</html>`;
}

function runChrome(args, outputPath) {
  const result = spawnSync(
    CHROME_BIN,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=/tmp/hale-poster-chrome-${process.pid}`,
      ...args,
    ],
    { encoding: 'utf8', timeout: 90_000 },
  );
  const wrote = existsSync(outputPath) && statSync(outputPath).size > 0;
  if (wrote && (result.error?.code === 'ETIMEDOUT' || result.status !== 0)) return;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`chrome failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function pdfToPng(pdfPath, pngPath) {
  const script = `
import sys
import pypdfium2 as pdfium
pdf = pdfium.PdfDocument(sys.argv[1])
img = pdf[0].render(scale=150/72).to_pil()
img.save(sys.argv[2], 'PNG')
`;
  const result = spawnSync('python3', ['-c', script, pdfPath, pngPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`pdf raster failed: ${result.stderr || result.stdout}`);
  }
}

function render(id) {
  const plate = plateFor(id);
  mkdirSync(PRINT, { recursive: true });
  const htmlPath = join(PRINT, `${plate.filename}.html`);
  const pdfPath = join(PRINT, `${plate.filename}.pdf`);
  const pngPath = join(PRINT, `${plate.filename}.png`);
  writeFileSync(htmlPath, posterHtml(plate));

  runChrome(
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    pdfPath,
  );
  pdfToPng(pdfPath, pngPath);

  process.stdout.write(`wrote ${htmlPath}\n${pdfPath}\n${pngPath}\n`);
}

const id = process.argv[2] ?? 'earlyon-ossington';
render(id);
