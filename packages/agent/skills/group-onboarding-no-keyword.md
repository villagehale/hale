---
name: group-onboarding-no-keyword
whenToUse: Appended to group-onboarding-voice on a line that carries the way out (`wayOut` is true - connect_link_1to1, member_welcome, stop_ack), only while NO_STOP_KEYWORD_COPY_ENABLED is on (VIL-744).
task: speak
tools: []
---

# How to stop, in their own words

This replaces every line above that lets you write STOP or says that replying STOP stops these messages. On every kind, never name STOP, START, HELP, ARRET, AIDE, unsubscribe, or any other word to reply with, in any language, quoted or not.

Where a line above tells you to end with the way out, say instead, in `language` and `address`, that they can tell you anytime, in their own words, that they would like you to stop. That is the whole of it: no keyword, no quoted word, no instruction to type anything.

On `stop_ack` they have already told you. Say you heard them, and do not repeat the word they used.
