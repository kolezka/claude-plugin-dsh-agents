---
description: List saved and live dsh sessions
argument-hint: "[cwd]"
disable-model-invocation: true
---

Call `mcp__plugin_dsh_dsh__sessions`, with `cwd` set to the argument when one is given: $ARGUMENTS

Show the sessions newest first as a short table: session id, title, working directory, last update and whether it is live in this Claude session (`liveHere`). Any session can be continued with `/dsh:ask --session <id> <task>`.
