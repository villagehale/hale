// Shared between the server (authed) layout's pre-paint script and the client
// AppShell. Lives outside the 'use client' module so the server reads the real
// string value, not a client-reference proxy.
export const SHELL_COLLAPSED_KEY = 'hale.shell.collapsed';
