import * as WebBrowser from 'expo-web-browser';

import { API_BASE } from './api-client';

/**
 * Open a Hale policy page (e.g. /terms, /privacy) in the in-app browser, rooted at
 * the configured API base — the same host the app talks to — so consent links
 * point at the live policies without hardcoding a URL.
 */
export function openPolicy(path: string): void {
  if (!API_BASE) return;
  void WebBrowser.openBrowserAsync(`${API_BASE}${path}`);
}
