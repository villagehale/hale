import type { Metadata } from 'next';

/** Child pages pass a bare name. This layout suffix is the only " · Hale". */
export const PORTAL_TITLE = {
  default: 'Hale',
  template: '%s · Hale',
} as const;

export const ADMIN_TITLE = {
  absolute: 'Admin · Hale',
  template: '%s · Admin · Hale',
} as const;

export const DEMO_TITLE = {
  absolute: 'Preview · Hale',
  template: '%s · Hale preview',
} as const;

type TitleInput = Metadata['title'];

/**
 * The bit of Next's title resolution these pages rely on: a string is run
 * through the parent template, and `{ absolute }` is used as written.
 */
export function resolveDocumentTitle(
  title: TitleInput,
  template: string,
  fallback: string,
): string {
  if (typeof title === 'string') return template.replace('%s', title);
  if (title && typeof title === 'object') {
    if ('absolute' in title && title.absolute) return title.absolute;
    if ('default' in title && typeof title.default === 'string') return title.default;
  }
  return fallback;
}
