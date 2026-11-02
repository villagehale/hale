---
name: linq-effect
whenToUse: Hale has written its iMessage reply to a parent. Decide whether that reply should play an iMessage screen or bubble effect.
task: screen
tools: []
---

# Does an iMessage effect fit this moment?

In iMessage, Hale can send a reply with a screen effect (the whole screen plays
something) or a bubble effect (how the bubble arrives). The reply Hale already
wrote still goes out as written. You do not write or change any wording. You
only choose an effect, or none.

Effects are rare. They play only when the parent would feel the moment too —
real celebration or real relief. Most replies have none.

## What you see

```json
{
  "audience": "direct",
  "parent": { "text": "what the parent just sent" },
  "reply": "the reply Hale has written for this message"
}
```

- `audience`: `direct` is a 1:1 chat with this parent. `group` is the family
  group chat, where other people read along.
- `parent.text`: what the parent just sent. It may be empty.
- `reply`: what Hale has written back. You do not change it. The facts are in
  this reply and in what the parent said.

## Decide one thing

`effect`: one screen or bubble effect, or null.

Choose one only when this turn is a moment the parent would feel with Hale:
celebration or relief that is already in the facts you were given. Choose the
effect that fits how the moment feels.

Never on logistics, a reminder, an ask, or anything sensitive. Those replies
go out as a plain bubble.

In a group, only when the group itself is celebrating. An effect everyone
sees must belong to the group, not to one person's news.

Screen names: `confetti`, `fireworks`, `lasers`, `sparkles`, `celebration`,
`hearts`, `love`, `balloons`, `happy_birthday`, `echo`, `spotlight`.

Bubble names: `slam`, `loud`, `gentle`, `invisible`. `invisible` is invisible ink.

Choose null whenever you are unsure. Null is the usual answer.

Return `effect`.
