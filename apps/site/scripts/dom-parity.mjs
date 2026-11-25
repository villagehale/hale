/**
 * Structural DOM parity: Prod vs a Preview, text stripped.
 *
 *   node apps/site/scripts/dom-parity.mjs \
 *     --prod https://villagehale.com \
 *     --preview https://site-git-….vercel.app
 *
 * Prints an empty diff when every element’s tag, class, id and child count match.
 * `--boxes` also prints top-level section, card and footer boxes at 1440 and 390.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const prod = flag('--prod', 'https://villagehale.com');
const preview = flag('--preview', '');
const boxes = args.includes('--boxes');
if (!preview) {
  console.error('Pass --preview <url>');
  process.exit(1);
}

const paths = ['/', '/fr', '/zh', '/pricing', '/fr/pricing', '/zh/pricing'];
const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
];

function serializePage() {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
  const lines = [];
  const walk = (el, depth) => {
    if (!el || skip.has(el.tagName)) return;
    const cls = (el.getAttribute('class') || '').trim().replace(/\s+/g, '.');
    const id = el.id ? `#${el.id}` : '';
    const kids = [...el.children].filter((child) => !skip.has(child.tagName));
    lines.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${id}[${kids.length}]`);
    for (const child of kids) walk(child, depth + 1);
  };
  walk(document.body, 0);
  return lines;
}

function diffLines(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) out.push(`- ${a[i] ?? '(missing)'}\n+ ${b[i] ?? '(missing)'}`);
    if (out.length > 40) break;
  }
  return out;
}

async function prepare(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hale-site-theme', 'light');
    localStorage.setItem('hale-site-consent', 'denied');
  });
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failed = false;
for (const path of paths) {
  const page = await browser.newPage({ viewport: viewports[0] });
  await prepare(page);
  await page.goto(prod + path, { waitUntil: 'networkidle', timeout: 60000 });
  const left = await page.evaluate(serializePage);
  await page.goto(preview + path, { waitUntil: 'networkidle', timeout: 60000 });
  const right = await page.evaluate(serializePage);
  await page.close();
  const delta = diffLines(left, right);
  console.log(`\n## ${path}  prod ${left.length}  preview ${right.length}`);
  if (delta.length === 0) console.log('EMPTY');
  else {
    failed = true;
    console.log(delta.join('\n'));
  }
}

if (boxes) {
  console.log('\n## boxes');
  for (const viewport of viewports) {
    for (const path of ['/', '/pricing']) {
      const rows = [];
      for (const [side, origin] of [
        ['prod', prod],
        ['preview', preview],
      ]) {
        const page = await browser.newPage({ viewport });
        await prepare(page);
        await page.goto(origin + path, { waitUntil: 'networkidle', timeout: 60000 });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        const found = await page.evaluate(() => {
          const nodes = [
            ...document.querySelectorAll('main, section, footer, .hs-tier, .hs-beat, .hs-card, .promo-card'),
          ];
          return nodes.map((el) => {
            const box = el.getBoundingClientRect();
            const top = Math.round(box.top + window.scrollY);
            return {
              key: `${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.')}#${el.id || ''}`,
              top,
              height: Math.round(box.height),
            };
          });
        });
        rows.push([side, found]);
        await page.close();
      }
      const [prodRows, previewRows] = rows;
      console.log(`\n### ${viewport.name} ${path}`);
      const n = Math.max(prodRows[1].length, previewRows[1].length);
      console.log('| element | prod top | preview top | dTop | prod h | preview h | dH |');
      console.log('| --- | --- | --- | --- | --- | --- | --- |');
      for (let i = 0; i < n; i++) {
        const a = prodRows[1][i];
        const b = previewRows[1][i];
        const dTop = a && b ? b.top - a.top : '';
        const dH = a && b ? b.height - a.height : '';
        const bad = a && b && (Math.abs(dTop) > 8 || Math.abs(dH) > 8);
        if (bad) failed = true;
        console.log(
          `| ${a?.key ?? b?.key ?? ''} | ${a?.top ?? ''} | ${b?.top ?? ''} | ${dTop} | ${a?.height ?? ''} | ${b?.height ?? ''} | ${dH}${bad ? ' | OVER' : ''} |`,
        );
      }
    }
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
