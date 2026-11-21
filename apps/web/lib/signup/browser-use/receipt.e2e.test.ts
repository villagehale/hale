import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ReceiptKeep, cardShapedNumber, maskAndCapture } from './receipt';

/**
 * The proof is differential: the same page rendered with two different secrets of the same
 * length, masked and captured. If any pixel depended on a secret, the PNG bytes would
 * differ. Local pages only; nothing here reaches a provider.
 */
const KEEP: ReceiptKeep = {
  confirmationNumber: 'R-55120',
  className: 'Get Ready Public Speaking',
  amount: '$84.88',
};

const A = {
  card: '4111111111111111',
  last4: '4242',
  exp: '09/29',
  password: 'hunter2-river',
  digits: '4111',
};
const B = {
  card: '5500005555555559',
  last4: '9876',
  exp: '11/31',
  password: 'correct-horse',
  digits: '5500',
};
type Secret = typeof A;

const shell = (head: string, body: string) => `<!doctype html><html><head>${head}</head>
<body style="margin:0;font:16px serif">
<h1>Thanks for registering</h1>
<p>Confirmation number <b id="num">R-55120</b></p>
<p>Class: <span>Get Ready Public Speaking</span></p>
<p>Total charged: <span>$84.88</span></p>
${body}
</body></html>`;

const svgData = (text: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text x="4" y="40" font-size="24">${text}</text></svg>`,
  )}`;

const FIXTURES: Record<string, (s: Secret) => string> = {
  'plain card text': (s) => shell('', `<p>Card: ${s.card}</p>`),
  'masked last four with expiry': (s) =>
    shell('', `<p>Visa ending in ${s.last4}, expires ${s.exp}</p>`),
  'plain-text password': (s) => shell('', `<p>Your temporary password: ${s.password}</p>`),
  'a password in the same element as the number': (s) =>
    shell('', `<p id="both">Confirmation R-55120 and password ${s.password}</p>`).replace(
      '<p>Confirmation number <b id="num">R-55120</b></p>',
      '',
    ),
  'input values': (s) =>
    shell('', `<input value="${s.card}"><input type="password" value="${s.password}">`),
  'img pixels': (s) => shell('', `<img alt="" src="${svgData(s.card)}">`),
  'css background image': (s) =>
    shell(
      `<style>.card{width:400px;height:60px;background-image:url("${svgData(s.card)}")}</style>`,
      '<div class="card"></div>',
    ),
  'body background image': (s) =>
    shell(`<style>body{background-image:url("${svgData(s.card)}")}</style>`, ''),
  'pseudo-element text': (s) =>
    shell(`<style>.tag::before{content:"${s.card}"}</style>`, '<p class="tag"></p>'),
  'a pseudo-element on a kept ancestor': (s) =>
    shell(`<style>p::after{content:" ${s.card}" !important}</style>`, ''),
  'closed shadow root': (s) =>
    shell(
      '',
      `<div id="host"></div><script>
        const root = document.getElementById('host').attachShadow({mode:'closed'});
        root.innerHTML = '<p style="visibility:visible !important">${s.card}</p>';
      </script>`,
    ),
  'open shadow root': (s) =>
    shell(
      '',
      `<div id="host"></div><script>
        const root = document.getElementById('host').attachShadow({mode:'open'});
        root.innerHTML = '<p>${s.card}</p>';
      </script>`,
    ),
  'digits split across elements': (s) =>
    shell('', `<p><span>${s.digits}</span><span>${s.digits}</span><b>${s.last4}</b></p>`),
  'non-ascii digits': (s) =>
    shell(
      '',
      `<p>${[...s.last4]
        .map((digit) => String.fromCodePoint(0x0660 + Number(digit)))
        .join('')}</p>`,
    ),
  'canvas pixels': (s) =>
    shell(
      '',
      `<canvas id="c" width="400" height="60"></canvas><script>
        const ctx = document.getElementById('c').getContext('2d');
        ctx.font = '24px serif';
        ctx.fillText('${s.card}', 4, 40);
      </script>`,
    ),
  'iframe content': (s) =>
    shell('', `<iframe srcdoc="<p>${s.card}</p>" width="400" height="80"></iframe>`),
  'a page script that re-renders the secret after the mask': (s) =>
    shell(
      '',
      `<script>
        setInterval(() => {
          const late = document.createElement('p');
          late.textContent = '${s.card}';
          document.body.appendChild(late);
        }, 5);
      </script>`,
    ),
};

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function rendered(html: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

async function capture(html: string, options?: { freeze?: boolean }) {
  const page = await rendered(html);
  try {
    return await maskAndCapture(page, KEEP, options);
  } finally {
    await page.context().close();
  }
}

async function unmasked(html: string): Promise<Buffer> {
  const page = await rendered(html);
  try {
    return await page.screenshot({ type: 'png', animations: 'disabled' });
  } finally {
    await page.context().close();
  }
}

describe('the masked receipt', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`no pixel depends on the secret: ${name}`, async () => {
      const first = await capture(fixture(A));
      const second = await capture(fixture(B));
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.receipt.png.equals(second.receipt.png)).toBe(true);
      expect(first.receipt.png.byteLength).toBeGreaterThan(100);
      // The kept strings are what is on it: a blank image would pass the comparison.
      expect(first.receipt.kept).toContain('R-55120');
    }, 30_000);

    it(`the same page unmasked shows the secret: ${name}`, async () => {
      // Positive control for the comparison above. Pixel-identical unmasked renders would
      // mean this fixture never put the secret on the screen.
      const [first, second] = [await unmasked(fixture(A)), await unmasked(fixture(B))];
      expect(first.equals(second)).toBe(false);
    }, 30_000);
  }

  it('keeps the class name and the amount when the page shows them', async () => {
    const result = await capture(shell('', ''));
    expect(result.ok && [...result.receipt.kept].sort()).toEqual(
      ['$84.88', 'Get Ready Public Speaking', 'R-55120'].sort(),
    );
  });

  it('keeps only the number when the rest is not on the page', async () => {
    const html = '<!doctype html><html><body><p>Number R-55120</p></body></html>';
    const result = await capture(html);
    expect(result.ok && result.receipt.kept).toEqual(['R-55120']);
  });

  it('the freeze stops a page script from painting the secret after the mask', async () => {
    // Writes the card into a visible, fixed element every few milliseconds. Only the freeze
    // stands between that script and the capture.
    const late = (card: string) =>
      shell(
        '',
        `<script>
          setInterval(() => {
            const el = document.createElement('div');
            el.textContent = '${card}';
            el.style.cssText = 'display:block !important;visibility:visible !important;position:fixed !important;left:16px;top:120px;z-index:2147483647';
            document.body.appendChild(el);
          }, 5);
        </script>`,
      );
    const run = async (freeze: boolean) => {
      const page = await rendered(late(A.card));
      try {
        return await maskAndCapture(page, KEEP, {
          freeze,
          afterMask: () => page.waitForTimeout(60),
        });
      } finally {
        await page.context().close();
      }
    };
    expect((await run(true)).ok).toBe(true);
    // The control: without the freeze the secret comes back, and the check refuses the image.
    expect(await run(false)).toEqual({ ok: false, reason: 'verify_failed' });
  }, 30_000);

  it('a page without the confirmation number leaves no image', async () => {
    const result = await capture('<!doctype html><html><body><p>Thanks!</p></body></html>');
    expect(result).toEqual({ ok: false, reason: 'verify_failed' });
  });

  it('a page the mask cannot clear leaves no image', async () => {
    // A rule more specific than the mask's own keeps a pseudo-element's text on a kept
    // ancestor. Only the check of what will paint can catch it.
    const stubborn = shell(
      `<style>
        #h #b #keeper#keeper#keeper::after {
          content: "${A.card}" !important;
          display: inline !important;
          visibility: visible !important;
        }
      </style>`,
      '',
    )
      .replace('<html>', '<html id="h">')
      .replace('<body ', '<body id="b" ')
      .replace('<p>Confirmation number', '<p id="keeper">Confirmation number');
    expect(await capture(stubborn)).toEqual({ ok: false, reason: 'verify_failed' });
  }, 30_000);
});

describe('cardShapedNumber', () => {
  it.each([
    '4111111111111111',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    'R-4111111111111',
    '٤١١١١١١١١١١١١١١١',
  ])('refuses %s', (value) => {
    expect(cardShapedNumber(value)).toBe(true);
  });

  it.each(['R-55120', 'CONF 123456789012', 'AB-12-34-56'])('allows %s', (value) => {
    expect(cardShapedNumber(value)).toBe(false);
  });
});
