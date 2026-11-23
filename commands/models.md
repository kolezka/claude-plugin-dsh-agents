---
description: Show the models and reasoning efforts dsh offers
argument-hint: "[session]"
disable-model-invocation: true
---

Call `mcp__plugin_dsh_dsh__models`, with `session` set to the argument when one is given: $ARGUMENTS

Show the model and reasoning effort options as a short list, marking the current values, and say whether they came from a live session or the cached options of the last session this server opened. When nothing is cached, say that a session must be started first, for example with `/dsh:ask`. Use a value as `/dsh:ask --model <provider/model> <task>`.
