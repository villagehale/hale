/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { Fragment, type ReactNode, act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '~/lib/theme';
import { AppearanceCard, AppearanceControl } from './appearance';
import styles from './portal.module.css';

vi.mock('~/auth', () => ({ signIn: vi.fn() }));
vi.mock('~/lib/auth/claim-phone-actions', () => ({ claimByPhoneAction: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "Auto follows this device's setting.";

let root: Root | null = null;
let prefersDark = false;
const mediaListeners = new Set<() => void>();

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('dark') ? prefersDark : false;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      mediaListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners.delete(listener);
    },
    dispatchEvent: () => true,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function options(container: ParentNode, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter(
    (el) => el.textContent === label,
  );
}

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  return container;
}

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function runHeadScript(source: string): void {
  // The string is the layout's own NO_FLASH_SCRIPT, read from disk.
  // biome-ignore lint/security/noGlobalEval: assert the real head script, not a reimplementation
  eval(source);
}

function noFlashSource(): { layout: string; script: string } {
  const layout = read('../../app/layout.tsx');
  const marker = 'const NO_FLASH_SCRIPT = `';
  const start = layout.indexOf(marker);
  const end = layout.indexOf('`;', start);
  const template = layout.slice(start + marker.length, end);
  const script = template.replace(
    '${JSON.stringify(THEME_STORAGE_KEY)}',
    JSON.stringify(THEME_STORAGE_KEY),
  );
  return { layout, script };
}

beforeEach(() => {
  prefersDark = false;
  mediaListeners.clear();
  installMatchMedia();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.themePref;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.replaceChildren();
});

describe('Appearance control', () => {
  it('defaults to Auto and does not write a preference until a choice is made', async () => {
    const container = await mount(createElement(AppearanceControl, { variant: 'card' }));
    const labels = [...container.querySelectorAll('[role="radio"]')].map((el) => el.textContent);

    expect(labels).toEqual(['Light', 'Dark', 'Auto']);
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'Appearance',
    );
    expect(options(container, 'Auto')[0]?.getAttribute('aria-checked')).toBe('true');
    expect(options(container, 'Light')[0]?.getAttribute('aria-checked')).toBe('false');
    expect(options(container, 'Dark')[0]?.getAttribute('aria-checked')).toBe('false');
    expect(options(container, 'Auto')[0]?.tabIndex).toBe(0);
    expect(options(container, 'Light')[0]?.tabIndex).toBe(-1);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('persists the choice on this device and restores it on the next mount', async () => {
    const first = await mount(createElement(AppearanceControl, { variant: 'side' }));
    await act(async () => {
      options(first, 'Dark')[0]?.click();
    });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.themePref).toBe('dark');
    expect(options(first, 'Dark')[0]?.getAttribute('aria-checked')).toBe('true');

    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.replaceChildren();

    const second = await mount(createElement(AppearanceControl, { variant: 'card' }));
    expect(options(second, 'Dark')[0]?.getAttribute('aria-checked')).toBe('true');
    expect(options(second, 'Auto')[0]?.getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('keeps the sidebar control and the Settings card in sync', async () => {
    const container = await mount(
      createElement(
        Fragment,
        null,
        createElement(AppearanceControl, { variant: 'side' }),
        createElement(AppearanceCard),
      ),
    );

    expect(container.querySelector('p')?.textContent).toBe(NOTE);
    expect(options(container, 'Auto')).toHaveLength(2);

    await act(async () => {
      options(container, 'Light')[0]?.click();
    });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    for (const button of options(container, 'Light')) {
      expect(button.getAttribute('aria-checked')).toBe('true');
      expect(button.className).toContain('segOn');
    }
    for (const button of options(container, 'Auto')) {
      expect(button.getAttribute('aria-checked')).toBe('false');
    }

    await act(async () => {
      options(container, 'Dark')[1]?.click();
    });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    for (const button of options(container, 'Dark')) {
      expect(button.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('follows the device while Auto is selected, and stops when a fixed choice is made', async () => {
    const container = await mount(createElement(AppearanceControl, { variant: 'card' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    prefersDark = true;
    await act(async () => {
      for (const listener of mediaListeners) listener();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await act(async () => {
      options(container, 'Light')[0]?.click();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    prefersDark = true;
    await act(async () => {
      for (const listener of mediaListeners) listener();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('moves the selection with the arrow keys and keeps a visible radio in the tab order', async () => {
    const container = await mount(createElement(AppearanceControl, { variant: 'side' }));
    const auto = options(container, 'Auto')[0];
    expect(auto).toBeDefined();
    auto?.focus();

    await act(async () => {
      auto?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });

    const dark = options(container, 'Dark')[0];
    expect(dark?.getAttribute('aria-checked')).toBe('true');
    expect(dark?.tabIndex).toBe(0);
    expect(options(container, 'Auto')[0]?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(dark);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('the pre-paint script', () => {
  it('is in the document head and paints the saved choice, or the device when none is saved', () => {
    const { layout, script } = noFlashSource();
    const head = layout.indexOf('<head>');
    const body = layout.indexOf('<body');
    const use = layout.indexOf('__html: NO_FLASH_SCRIPT');

    expect(head).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(head);
    expect(use).toBeLessThan(body);
    expect(script).toContain("if(p!=='light'&&p!=='dark'&&p!=='system')p='system'");
    expect(script).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(script).toContain("document.documentElement.classList.toggle('dark',dark)");
    expect(script).toContain('document.documentElement.dataset.themePref=p');
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));

    localStorage.clear();
    prefersDark = true;
    document.documentElement.classList.remove('dark');
    delete document.documentElement.dataset.themePref;
    runHeadScript(script);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.themePref).toBe('system');

    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runHeadScript(script);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.themePref).toBe('light');

    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runHeadScript(script);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.themePref).toBe('dark');

    localStorage.setItem(THEME_STORAGE_KEY, 'nope');
    prefersDark = false;
    runHeadScript(script);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.themePref).toBe('system');
  });
});

const INK = '#17294a';
const DARK_SHADOW = '0 1px 3px rgb(12 26 54 / 0.12)';

/** happy-dom does not load Vite's CSS module. Replay the real stylesheet with
 *  the same class names the component renders, so the first frame is measured.
 *  `.dark` stays global — it is not a module class. */
function installPortalCss(): void {
  const source = read('./portal.module.css');
  const localSource = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/:global\(([^)]+)\)/g, ' ');
  const names = [
    ...new Set([...localSource.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map((m) => m[1])),
  ].sort((a, b) => b.length - a.length);
  let css = source.replaceAll(/:global\(([^)]+)\)/g, '$1');
  const map = styles as unknown as Record<string, string>;
  names.forEach((name, index) => {
    css = css.replaceAll(`.${name}`, `.__cls${index}__`);
  });
  names.forEach((name, index) => {
    css = css.replaceAll(`.__cls${index}__`, `.${map[name]}`);
  });
  const tag = document.createElement('style');
  tag.dataset.portal = 'true';
  tag.textContent = css;
  document.head.appendChild(tag);
}

function paint(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.className = styles.shell;
  host.innerHTML = markup;
  document.body.appendChild(host);
  return host;
}

function tone(root: ParentNode, pref: string): { color: string; shadow: string } {
  const button = root.querySelector<HTMLElement>(`[data-pref="${pref}"]`);
  if (!button) throw new Error(`missing option ${pref}`);
  const style = getComputedStyle(button);
  return { color: style.color, shadow: style.boxShadow };
}

describe('the stored option is selected before hydration', () => {
  beforeEach(() => {
    installPortalCss();
  });

  afterEach(() => {
    document.head.querySelector('[data-portal]')?.remove();
  });

  it('paints Dark from the first frame, in the sidebar and the card, and Auto stays idle', () => {
    const css = read('./portal.module.css');
    expect(css).toMatch(
      /:global\(html\[data-theme-pref="dark"\]\)\s+\.shell\s+\.look:not\(\[data-ready\]\)\s+button\.lookOpt\[data-pref="dark"\]/,
    );
    expect(css).toContain('.shell .look:not([data-ready]) button.lookOpt.segOn');
    expect(css).toContain('background: rgb(255 255 255 / 0.92)');
    expect(css).toContain('color: #17294a');
    expect(css).not.toMatch(/\.shell button\.segOn:not\(\[data-ready\]\)/);

    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runHeadScript(noFlashSource().script);

    const markup = renderToStaticMarkup(createElement(AppearanceControl, { variant: 'card' }));
    expect(markup).toContain('data-pref="light"');
    expect(markup).toContain('data-pref="dark"');
    expect(markup).toContain('data-pref="system"');
    expect(markup).not.toContain('data-ready');

    const host = paint(markup);
    expect(host.querySelector('[role="radiogroup"]')?.hasAttribute('data-ready')).toBe(false);

    const selected = { color: INK, shadow: DARK_SHADOW };
    expect(tone(host, 'dark')).toEqual(selected);
    expect(tone(host, 'system').shadow).toBe('none');
    expect(tone(host, 'system').color).not.toBe(INK);
    expect(tone(host, 'light').shadow).toBe('');

    const side = paint(renderToStaticMarkup(createElement(AppearanceControl, { variant: 'side' })));
    expect(tone(side, 'dark')).toEqual(selected);
    expect(tone(side, 'system').shadow).toBe('none');

    const filter = document.createElement('button');
    filter.className = styles.segOn;
    host.appendChild(filter);
    expect(getComputedStyle(filter).boxShadow).toBe(DARK_SHADOW);
  });

  it('keeps that same Dark pill once the control is ready, and choose() updates the preference', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    document.documentElement.dataset.themePref = 'dark';
    document.documentElement.classList.add('dark');

    const before = paint(
      renderToStaticMarkup(createElement(AppearanceControl, { variant: 'card' })),
    );
    const first = tone(before, 'dark');

    const container = await mount(
      createElement(
        'div',
        { className: styles.shell },
        createElement(AppearanceControl, { variant: 'card' }),
      ),
    );
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.hasAttribute('data-ready')).toBe(true);
    expect(options(container, 'Dark')[0]?.getAttribute('aria-checked')).toBe('true');
    expect(tone(container, 'dark')).toEqual(first);
    expect(tone(container, 'system').shadow).toBe('');

    await act(async () => {
      options(container, 'Light')[0]?.click();
    });
    expect(document.documentElement.dataset.themePref).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(tone(container, 'light').color).toBe(INK);
    expect(tone(container, 'light').shadow).toContain('inset');
    expect(tone(container, 'dark').shadow).toBe('');
  });
});

describe('where the control lives', () => {
  const shell = read('./shell.tsx');
  const settings = read('./settings-index.tsx');
  const css = read('./portal.module.css');

  it('pins the sidebar control above Sign out, and leaves it out of the phone tab bar', () => {
    const foot = shell.indexOf('styles.sideFoot');
    const control = shell.indexOf('<AppearanceControl variant="side" />');
    const signOut = shell.indexOf('Sign out', control);
    const tabbar = shell.indexOf('styles.tabbar');

    expect(foot).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(foot);
    expect(signOut).toBeGreaterThan(control);
    expect(tabbar).toBeGreaterThan(signOut);
    expect(shell.slice(tabbar)).not.toContain('Appearance');
    expect(css).toMatch(/\.side\s*\{[^}]*display:\s*none/);
    expect(css).toContain('.lookSide {\n  margin: 0 0 var(--s2);\n}');
    expect(css).toContain('--s2: 8px;');
    expect(css).toContain('margin-top: auto;');
    expect(css).toMatch(
      /\.sideFoot \.signoutForm,\s*\n\s*\.sideFoot \.signout \{\s*\n\s*margin-top: 0;/,
    );
  });

  it('puts the Appearance card after You and above Sign out, with the exact note', () => {
    const you = settings.indexOf('>You<');
    const card = settings.indexOf('<AppearanceCard />');
    const signOut = settings.indexOf('mobileOut');

    expect(you).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(you);
    expect(signOut).toBeGreaterThan(card);
    expect(read('./appearance.tsx')).toContain(`Auto follows this device's setting.`);
    expect(read('./appearance.tsx')).toContain('styles.segOn');
  });

  it('corrects the stylesheet comment that said a missing preference ignores the device', () => {
    expect(css).not.toContain('does not follow the OS');
    expect(css).toContain('follows the device (`prefers-color-scheme`)');
    expect(css).toContain('box-shadow: inset 0 0 0 1px #6e7d99, 0 1px 3px rgb(12 26 54 / 0.12)');
  });
});

describe('/sign-in has no toggle', () => {
  async function renderSignIn(): Promise<string> {
    vi.resetModules();
    const { default: SignInPage } = await import('~/app/sign-in/page');
    return renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
  }

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.AUTH_SECRET = 'test-auth-secret';
    process.env.F14_RECEIPTS_IA = '';
  });

  afterEach(() => {
    process.env.F14_RECEIPTS_IA = '';
  });

  it('offers neither the portal control nor a theme toggle on the phone door', async () => {
    process.env.F14_RECEIPTS_IA = 'true';
    const html = await renderSignIn();

    expect(html).not.toContain('aria-label="Appearance"');
    expect(html).not.toContain(NOTE);
    expect(html).not.toContain('>Auto<');
    expect(html).not.toContain('>Light<');
    expect(html).not.toContain('theme-toggle');
    expect(html).toContain('claim-phone');
  });

  it('keeps the flag-off door free of the portal control', async () => {
    const html = await renderSignIn();

    expect(html).not.toContain('aria-label="Appearance"');
    expect(html).not.toContain(NOTE);
    expect(html).not.toContain('>Auto<');
    expect(html).toContain('Continue with Google');
  });

  it('does not mount the control on the demo sign-in page', () => {
    const page = read('../../app/demo/sign-in/page.tsx');
    expect(page).not.toContain('Appearance');
    expect(page).not.toContain('theme-toggle');
    expect(page).not.toContain('ThemeToggle');
  });
});
