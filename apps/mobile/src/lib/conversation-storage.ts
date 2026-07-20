import { tokenStorage } from './token-storage';

/** Storage key for the Ask screen's active conversation id — persisted so a cold
 * start reopens the last thread. Distinct from the session token; same underlying
 * store (Keychain/Keystore on native, localStorage on the web preview). */
const CONVERSATION_KEY = 'hale.ask.conversationId';

export const conversationStorage = {
  get(): Promise<string | null> {
    return tokenStorage.get(CONVERSATION_KEY);
  },
  set(id: string): Promise<void> {
    return tokenStorage.set(CONVERSATION_KEY, id);
  },
  clear(): Promise<void> {
    return tokenStorage.remove(CONVERSATION_KEY);
  },
};
