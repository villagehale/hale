# Onboarding golden conversations

The suite in `apps/web/lib/channel/intake/golden-conversation.test.ts` drives the real intake machine through onboarding. The friend-voice model and the activity search are deterministic stand-ins, so the run does not call Anthropic and does not need a network. Vitest picks the file up with the rest of the web tests, which is how it runs in CI.

From the repo root:

```bash
pnpm --filter @hale/web exec vitest run lib/channel/intake/golden-conversation.test.ts
```

The same file also runs as part of:

```bash
pnpm --filter @hale/web test
```

What it covers:

1. Postal code, then ages, then the activity list, then a pick, then names, then calendar and Gmail, then the thread is handed to chat.
2. Postal code, ages, a pick, a name, and calendar all in the first message.
3. Two of those items in one message.
4. An off-script reply at every step. The reply answers it and comes back to the current question. No step is silent.
5. Two messages sent one after another. Each gets its own reply.
6. The Linq card and the vCard name are Hale followed by U+1F33A, and the card setup runs after the reply.
7. Typing starts when the inbound is received and is still up until the send, including a search that outlives one Linq typing hold.
8. None of the known canned onboarding strings are in the messages that were sent.

A change under `apps/web/lib/channel/intake` has to leave this file green.
