import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar, avatarShowsImage } from './avatar';

/**
 * The shared people-avatar: a photo when `src` is set, else a tinted initials disc.
 * These assert the load-bearing render decision (photo vs initials), the tone class
 * that keeps the parent (navy) and child (warm) discs distinct, and the no-referrer
 * policy Google photos need. The onError→initials fallback is client-runtime and is
 * exercised in the browser, not here.
 */
function render(props: Parameters<typeof Avatar>[0]): string {
  return renderToStaticMarkup(createElement(Avatar, props));
}

describe('Avatar', () => {
  it('renders the initials disc when there is no src', () => {
    const html = render({ initials: 'S', tone: 'child' });
    expect(html).toContain('>S</span>');
    expect(html).toContain('avatar-child');
    expect(html).not.toContain('<img');
  });

  it('renders the photo when src is set — decorative, with no referrer for google photos', () => {
    const html = render({
      src: 'https://lh3.googleusercontent.com/a/photo',
      initials: 'BD',
      tone: 'account',
    });
    expect(html).toContain('<img');
    expect(html).toContain('src="https://lh3.googleusercontent.com/a/photo"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('alt=""');
    // A photo shows no initials text.
    expect(html).not.toContain('>BD</');
  });

  it('carries the tone class so account (navy) and child (warm) discs read apart', () => {
    expect(render({ initials: 'BD', tone: 'account' })).toContain('avatar-account');
    expect(render({ initials: 'S', tone: 'child' })).toContain('avatar-child');
  });
});

describe('avatarShowsImage — retry a NEW src after a load error', () => {
  it('shows the image for a present src that has not failed', () => {
    expect(avatarShowsImage('https://x/a.jpg', null)).toBe(true);
  });

  it('falls back to initials for the exact src that failed', () => {
    expect(avatarShowsImage('https://x/a.jpg', 'https://x/a.jpg')).toBe(false);
  });

  it('RETRIES a different src even after a prior error (recovers without remount)', () => {
    // a.jpg failed; a re-upload / rotated signed URL gives b.jpg → show it, not initials.
    expect(avatarShowsImage('https://x/b.jpg', 'https://x/a.jpg')).toBe(true);
  });

  it('shows initials when there is no src', () => {
    expect(avatarShowsImage(null, null)).toBe(false);
    expect(avatarShowsImage(undefined, 'https://x/a.jpg')).toBe(false);
  });
});
