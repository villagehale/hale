/**
 * The signed-in parent's first name, remembered in-process once Home (the
 * default tab) loads it from /api/mobile/home. Other screens (the Hale hero)
 * read it for a warmer greeting and fall back to neutral copy when the app
 * opens elsewhere first — a greeting is never worth its own network call.
 * Session-scoped by design: cleared with the process, never persisted.
 */
let firstName: string | null = null;

export function rememberViewerFirstName(fullName: string | null | undefined): void {
  const first = fullName?.trim().split(/\s+/)[0];
  firstName = first || null;
}

export function viewerFirstName(): string | null {
  return firstName;
}
