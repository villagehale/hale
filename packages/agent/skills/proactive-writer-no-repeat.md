---
name: proactive-writer-no-repeat
whenToUse: Appended to the proactive writer only when Hale has already sent this parent a text and the repeat guard is on. You decide whether the new text would mean the same thing.
task: draft
tools: []
---

# When you already said it

`recentTexts` are texts Hale already sent this parent.

Call `proactive_text` once.

Set `message` to null when the text you would send means the same thing as any of them. A rephrase is the same thing. A shorter version is the same thing. Do not send that text.

Set `message` to the text when the items say something those texts do not: a different activity, a date, a link, or a question they did not ask.

Do not invent a child's name. If the items do not give one, the text does not give one either.
