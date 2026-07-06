import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { type OnboardingDraft, isDraftShape } from './onboarding-draft';

/**
 * Draft persistence. The intake is saved after each step so it survives the app
 * closing during email verification (the email flow leaves the app; the parent
 * signs in and the saved draft is submitted). Stored in the Keychain/Keystore via
 * expo-secure-store — the same secure store as the session token, no extra
 * dependency — because it holds a child's name + full DOB (rule #1).
 *
 * Web (the dev preview only) has no secure-store implementation, so it falls back
 * to localStorage, mirroring token-storage.ts. Web is not a shipping target.
 */

const DRAFT_KEY = 'hale.onboarding.draft';

async function readRaw(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(DRAFT_KEY) ?? null;
  return SecureStore.getItemAsync(DRAFT_KEY);
}

export const onboardingDraftStore = {
  async save(draft: OnboardingDraft): Promise<void> {
    const raw = JSON.stringify(draft);
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(DRAFT_KEY, raw);
      return;
    }
    await SecureStore.setItemAsync(DRAFT_KEY, raw);
  },
  /** The saved draft, or null when there is none (or a stored value is unparseable). */
  async load(): Promise<OnboardingDraft | null> {
    const raw = await readRaw();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isDraftShape(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async clear(): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(DRAFT_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(DRAFT_KEY);
  },
};
