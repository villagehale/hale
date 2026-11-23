import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ReceiptKeep,
  captureMaskedReceipt,
  cardShapedNumber,
  confirmationNumberAllowed,
  renderReceipt,
} from './receipt';

/**
 * The proof is differential: the same page rendered with two different secrets of the same
 * length, and a receipt taken from each. If any pixel depended on a secret, the PNG bytes
 * would differ. Local pages only; nothing here reaches a provider.
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
  'a background image in a shadow root on a holder of the number': (s) =>
    shell(
      '',
      `<script>
        const holder = document.getElementById('num').parentElement;
        const root = holder.attachShadow({ mode: 'closed' });
        root.innerHTML = '<slot></slot><div style="visibility:visible !important;width:400px;height:60px"></div>';
        root.querySelector('div').style.setProperty(
          'background-image',
          ${JSON.stringify(`url("${svgData(s.card)}")`)},
          'important',
        );
      </script>`,
    ),
  'a background image on a pseudo-element no mask rule outranks': (s) =>
    shell(
      `<style>
        #h #b #keeper#keeper#keeper::after {
          content: "" !important;
          display: block !important;
          visibility: visible !important;
          width: 400px !important;
          height: 60px !important;
          background-image: url("${svgData(s.card)}") !important;
        }
      </style>`,
      '',
    )
      .replace('<html>', '<html id="h">')
      .replace('<body ', '<body id="b" ')
      .replace('<p>Confirmation number', '<p id="keeper">Confirmation number'),
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

async function capture(html: string, keep: ReceiptKeep = KEEP) {
  const page = await rendered(html);
  try {
    return await renderReceipt(page, keep);
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

  it('what the image holds is the kept strings: another number gives other pixels', async () => {
    // The control for "byte-identical": a capture that painted nothing would also match.
    const first = await capture(shell('', ''));
    const other = await capture(shell('', '').replaceAll('R-55120', 'R-55121'), {
      ...KEEP,
      confirmationNumber: 'R-55121',
    });
    expect(first.ok && other.ok).toBe(true);
    if (!first.ok || !other.ok) return;
    expect(first.receipt.png.equals(other.receipt.png)).toBe(false);
  });

  it('leaves the provider page as it found it, and leaves no extra page open', async () => {
    const page = await rendered(shell('', `<p>Card: ${A.card}</p>`));
    try {
      const before = await page.content();
      const result = await renderReceipt(page, KEEP);
      expect(result.ok).toBe(true);
      expect(await page.content()).toBe(before);
      expect(page.context().pages()).toEqual([page]);
    } finally {
      await page.context().close();
    }
  });

  it('a page script that lies about the read cannot put its own string on the image', async () => {
    const answering = (answer: string) =>
      shell('', `<script>Array.prototype.map = function () { return ${answer}; };</script>`);
    // An answer that is not a yes or no per string reads as not shown: no image at all.
    expect(await capture(answering(`['${A.card}', '${A.card}', '${A.card}']`))).toEqual({
      ok: false,
      reason: 'verify_failed',
    });
    // "All of them are shown" can only put Hale's own strings on it.
    const lied = await capture(answering('[true, true, true]'));
    expect(lied.ok && lied.receipt.kept).toEqual([
      'R-55120',
      'Get Ready Public Speaking',
      '$84.88',
    ]);
  });

  it('a kept string shaped like a card number is left off', async () => {
    const page = shell('', `<p>${A.card}</p>`);
    const result = await capture(page, { ...KEEP, className: A.card });
    expect(result.ok && result.receipt.kept).toEqual(['R-55120', '$84.88']);
  });

  it('a page without the confirmation number leaves no image', async () => {
    const result = await capture('<!doctype html><html><body><p>Thanks!</p></body></html>');
    expect(result).toEqual({ ok: false, reason: 'verify_failed' });
  });
});

describe('the capture deadline', () => {
  const PROVIDER = 'https://register.example-rec.test/Clients/Confirmed';

  it('a page whose main thread never yields ends capture_failed at the deadline', async () => {
    const hungBrowser = await chromium.launch();
    try {
      const context = await hungBrowser.newContext();
      const page = await context.newPage();
      await page.route(`${PROVIDER}**`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><p>R-55120</p>
            <script>setTimeout(() => { while (true) {} }, 0);</script></body></html>`,
        }),
      );
      await page.goto(PROVIDER, { waitUntil: 'commit' });
      const started = Date.now();
      const closed = { calls: 0 };
      const result = await captureMaskedReceipt(
        {
          getCdpUrl: async () => 'ws://fixture',
          connect: async () => ({
            contexts: () => hungBrowser.contexts(),
            close: async () => {
              closed.calls += 1;
            },
          }),
        },
        {
          browserId: 'browser-1',
          registrationUrl: PROVIDER,
          keep: KEEP,
          waitUntil: new Date(Date.now() + 1_500),
        },
      );
      expect(result).toEqual({ ok: false, reason: 'capture_failed' });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(closed.calls).toBe(1);
    } finally {
      await hungBrowser.close();
    }
  }, 30_000);

  it('a connect that never answers ends capture_failed at the deadline', async () => {
    const result = await captureMaskedReceipt(
      {
        getCdpUrl: async () => 'ws://fixture',
        connect: () => new Promise(() => undefined),
      },
      {
        browserId: 'browser-1',
        registrationUrl: PROVIDER,
        keep: KEEP,
        waitUntil: new Date(Date.now() + 200),
      },
    );
    expect(result).toEqual({ ok: false, reason: 'capture_failed' });
  });

  it('a sweep already out of time does not try', async () => {
    const getCdpUrl = async () => {
      throw new Error('must not be asked');
    };
    await expect(
      captureMaskedReceipt(
        { getCdpUrl },
        {
          browserId: 'browser-1',
          registrationUrl: PROVIDER,
          keep: KEEP,
          waitUntil: new Date(Date.now() - 1),
        },
      ),
    ).resolves.toEqual({ ok: false, reason: 'capture_failed' });
  });

  it('a run with no browser id is a named failure', async () => {
    await expect(
      captureMaskedReceipt(
        { getCdpUrl: async () => null },
        {
          browserId: null,
          registrationUrl: PROVIDER,
          keep: KEEP,
          waitUntil: new Date(Date.now() + 1_000),
        },
      ),
    ).resolves.toEqual({ ok: false, reason: 'no_browser' });
  });
});

describe('what may be drawn as a confirmation number', () => {
  it.each(['R-55120', 'HR-20417', 'ABC123', 'R-777', 'CONF-123456789012'])('allows %s', (value) => {
    expect(confirmationNumberAllowed(value)).toBe(true);
  });

  it.each([
    ['a card with dots', '4111.1111.1111.1111'],
    ['a card with slashes', '4111/1111/1111/1111'],
    ['a card with underscores', '4111_1111_1111_1111'],
    ['a card with en dashes', '4111\u20131111\u20131111\u20131111'],
    ['a card with non-breaking hyphens', '4111\u20111111\u20111111\u20111111'],
    ['a card with single hyphens', '4111-1111-1111-1111'],
    ['thirteen digits in two tokens', 'R1234567-890123'],
    ['spaces', 'R 55120'],
    ['three tokens', 'AB-12-34'],
    ['a sentence', 'your order is R-55120'],
    ['nothing', ''],
  ])('refuses %s', (_case, value) => {
    expect(confirmationNumberAllowed(value)).toBe(false);
  });

  it.each([
    ['4111.1111.1111.1111', 'card_shaped'],
    ['AB-12-34', 'not_a_confirmation'],
  ])('%s leaves no image, by name', async (value, reason) => {
    const result = await capture(shell('', `<p>${value}</p>`), {
      ...KEEP,
      confirmationNumber: value,
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it('the number must stand alone on the page, not inside a longer one', async () => {
    const html = '<!doctype html><html><body><p>Order XR-551209</p></body></html>';
    expect(await capture(html)).toEqual({ ok: false, reason: 'verify_failed' });
    const alone = '<!doctype html><html><body><p>Order: R-55120.</p></body></html>';
    expect((await capture(alone)).ok).toBe(true);
  });
});

describe('cardShapedNumber', () => {
  it.each([
    '4111111111111111',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    'R-4111111111111',
    '٤١١١١١١١١١١١١١١١',
    '4111.1111.1111.1111',
    '4111/1111/1111/1111',
    '4111_1111_1111_1111',
    '4111\u20131111\u20131111\u20131111',
    '4111\u20111111\u20111111\u20111111',
  ])('refuses %s', (value) => {
    expect(cardShapedNumber(value)).toBe(true);
  });

  it.each(['R-55120', 'CONF 123456789012', 'AB-12-34-56'])('allows %s', (value) => {
    expect(cardShapedNumber(value)).toBe(false);
  });
});
