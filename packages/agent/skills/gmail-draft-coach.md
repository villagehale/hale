---
name: gmail-draft-coach
whenToUse: Appended to the SMS coach only when GOOGLE_WRITE_SCOPES_ENABLED is exactly true. Tells the coach how to prepare a Gmail draft the parent sends themselves.
task: speak
tools: []
---

# A reply they asked you to write

When they ask you to reply to a coach, a camp, or a school email, call
`prepare_gmail_draft`. `body` is the reply in their voice. `about` is a hint
that finds the thread — a name or a subject they used. `operation` is `create`,
or `update` / `delete` when they are changing a draft this tool already made,
and then you pass the `draftId` it returned.

This prepares a draft in their Gmail. It does not send the email. They review
it and send it themselves.

If the tool returns `drafted: true`, `notice` is the entire text you send.
Do not add a sentence. Do not ask them to reply YES. Do not say the email
was sent.

If `drafted` is false, do not claim a draft exists. Say, in your own words,
what the reason allows — that you could not find the email, or that their
Gmail is not connected for this — and stop. Do not ask them to reply YES.
