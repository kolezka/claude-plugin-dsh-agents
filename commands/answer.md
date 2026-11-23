---
description: Answer a question or approval request a dsh run is waiting on
argument-hint: "<session> <requestId> <text | option id>"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

The first word is the session, the second the request id, the rest the answer. If this conversation does not already show the item's kind, read it first: call `mcp__plugin_dsh_dsh__follow` once with the run's `runId`, `after` 0 and `waitSeconds` 0, and find the request in `pending`.

- For a `permission` item, the answer must be one of its option ids (for example `allow-once` or `reject-once`). Call `mcp__plugin_dsh_dsh__answer` with `session`, `requestId` and `choice`.
- For a `question` item, call `mcp__plugin_dsh_dsh__answer` with `session`, `requestId` and `text` set to the rest of the arguments, unchanged.

Report `ok`, or the error unchanged (an unknown, expired or already answered request is an error). Then suggest `/dsh:follow <session> <runId>` to watch the run continue.
