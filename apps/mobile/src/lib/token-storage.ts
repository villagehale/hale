import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Session-token persistence. Native uses the Keychain/Keystore via
 * expo-secure-store; that module has no web implementation, so on web (the dev
 * preview) we fall back to localStorage. Web is not a shipping target for the
 * sensitive token — this only keeps the preview/build working.
 */
export const tokenStorage = {
  get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return Promise.resolve(globalThis.localStorage?.getItem(key) ?? null);
    }
    return SecureStore.getItemAsync(key);
  },
  set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(key, value);
      return Promise.resolve();
    }
    return SecureStore.setItemAsync(key, value);
  },
  remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(key);
      return Promise.resolve();
    }
    return SecureStore.deleteItemAsync(key);
  },
};
