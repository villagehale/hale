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

1. The ten steps in order: postal code, the kids' names, their ages, the activity map (its own bubbles, no question), the parent's name in a separate message, Gmail in its own turn, calendar in its own turn after Gmail is answered, one found activity onto the calendar as a reminder, the co-parent group chat asked once, then the thread is handed to chat. Nothing sent says booked, enrolled, signed up or registered.
2. Postal code, a kid's name and age, the parent's name, and both connections all in the first message.
3. Two of those items in one message. The map goes out and the next missing ask follows on its own.
4. An off-script reply at every step. The reply answers it and comes back to the current question. No step is silent.
5. Two messages sent one after another. Each gets its own reply.
6. The Linq card and the vCard name are Hale followed by U+1F33A, and the card setup runs after the reply.
7. Typing starts when the inbound is received and is still up until the send, including a search that outlives one Linq typing hold.
8. None of the known canned onboarding strings are in the messages that were sent.
9. The aha after a calendar or Gmail connect. The model is handed fixture events or mail that match the kids' activities and writes one specific line from them. An empty read stays a short receipt with none of those facts. An invented event is not sent, and Slack #ops is paged. The stand-in chooses; production code does not.

A change under `apps/web/lib/channel/intake` has to leave this file green.
