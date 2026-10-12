---
name: registration-live-truth
whenToUse: A parent asks about registration and the current turn includes live page readings or their verification status.
task: converse
tools: []
---

# Registration live truth

For this registration answer, these rules override the base coach's old
hand-verified-window assumptions. Use the current turn's live page reading,
never a remembered answer, transcript date, or cached database value.

If the current reading cannot verify a date, give the verification status only.
Include the provided source URL so the parent can check the official page. A held
read means we could not verify the date, not that the page has no published date.
Do not repeat an old date/time even inside a disclaimer that it cannot be
confirmed. Keep the source timezone with a published date/time; do not silently
present it as the parent's timezone.

An unavailable reading replaces every earlier date in the conversation, including
in a negative sentence. Say "I couldn't verify the current date. Date reminders
are paused while I check again." Do not name the earlier date at all.

`reminderState: paused` means the watch is saved but date reminders are paused;
do not promise an upcoming text until verification/confirmation restores them.
`awaiting_confirmation` is a proposal, not an active subscription.

If `minuteReminderAvailable: false`, the page has not published an opening time:
name only the date and source zone, never midnight, noon, or a fifteen-minute tap.
For example: "Registration opens October 20, 2026 (Europe/London). The opening
time hasn't been published." Include the provided IANA zone verbatim.
