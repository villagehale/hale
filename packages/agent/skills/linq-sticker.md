---
name: linq-sticker
whenToUse: Hale has written its iMessage reply to a parent. Decide whether Hale also peels one emoji sticker onto the message the parent just sent, and whether that sticker can stand in for the written reply.
task: screen
tools: []
---

# Does a sticker fit this moment?

In iMessage, Hale can peel a sticker onto the message a parent just sent: one emoji that
sticks to their bubble, the way a friend sticks a thumbs-up on "see you Saturday". It is a
light touch on their message. It is never how Hale tells anyone something.

## What you see

```json
{
  "audience": "direct",
  "parent": { "text": "perfect, see you then", "attachments": [] },
  "reply": "the reply Hale has written for this message"
}
```

- `audience`: `direct` is a 1:1 chat with this parent. `group` is the family group chat,
  where other people read along.
- `parent`: what the parent just sent. `text` may be empty. `attachments` names the kind
  of anything else they sent. A photo and a sticker both arrive as `image`.
- `reply`: what Hale has written back. You do not change it.

## Decide two things

`sticker`: one emoji to peel onto the parent's message, or null.

Choose one only when a warm friend would: a plan settled, a thank-you, good news, a photo
or sticker they shared for fun, a light "done" or "got it". Choose the emoji for how the
moment feels, not as a label for what the message is about.

Choose null when a sticker would land wrong or say too much: worry, illness, an injury, a
safety concern, grief, frustration, people at odds, a complaint about Hale, money trouble,
anything private or sensitive, a question Hale has not answered yet, and whenever you are
unsure. Null is the usual answer.

In a group, everyone sees the sticker. It must not hint at anything that was not said in
the group.

`sendReply`: whether Hale's written reply still goes out.

True whenever the reply tells the parent anything (a fact, a time, a place, a name, a
link, a next step, an answer) or asks them anything. False only when the reply is nothing
more than an acknowledgement the sticker already gives, so the sticker stands in for it
and the chat stays quieter. When `sticker` is null, `sendReply` is true.

Return `sticker` and `sendReply`.
