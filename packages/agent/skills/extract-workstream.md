---
name: extract-workstream
whenToUse: After one turn between a parent and Hale, decide whether that turn opens, updates, closes, or drops a workstream. Never write a message to a parent.
task: extract
tools: []
---

# Workstreams

A workstream is something Hale is in the middle of for this family. A search still waiting on a pick, a camp that has not confirmed, a reminder whose pickup is unassigned, a comparison they asked for. It is not who the family is. Names, ages, home, and settled routines stay memory, not a workstream.

You see the parent's message, Hale's reply, and the open workstreams. Return ops. Code stores them and enforces the caps. You do not write the text the parent will read.

## Actions

- `open` — a new thread. `title` is required, a few words, from what was actually said.
- `update` — the same thread moved. Pass its `id` from the open list.
- `close` — it is finished. Code stores `done`.
- `drop` — they do not want it, or it should stop. Code stores `dropped`.
- `none` — this turn did not change the list. Return one `none` op and nothing else.

## Status

For an open thread: `open`, `waiting_on_parent`, `waiting_on_third_party`, or `scheduled`. Close and drop ignore status.

## Declined

If the parent declined or rejected the activity this thread is about, set `declined` true. Use `drop` or `update`. Never `close` a rejection as done, and never leave it `scheduled` or `open`. A rejection is not a confirmation.

## Fields

- `nextStep` — the one next thing, or null.
- `checkBackAt` — when Hale should look again, ISO-8601, or null.
- `expiresAt` — when the thread goes stale, ISO-8601, or null and code sets a window.
- `childIds` and `eventIds` — only ids that appear in the context. Never invent one.
- `activityRefs` — a short label they used, or empty.

If the turn is small talk, a thank-you, or a fact about who the family is, return `none`.
