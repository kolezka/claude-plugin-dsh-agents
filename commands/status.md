---
description: Check that dsh is reachable and show the profile, overlays and live sessions
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor)
disable-model-invocation: true
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor` and keep its exit code.

Summarise in a few lines: the dsh binary and version (and any tested-version warning), the profile, the patch overlays, the default model route, the permission preset and approval policy, the MCP servers dsh will connect, and whether the ACP handshake worked. Show every warning and failure line as printed.

Then call `mcp__plugin_dsh_dsh__sessions` with `limit` 10 and list the sessions with `liveHere: true`: those are held by this Claude session's dsh child. If none are live, say the child starts on the first task.

When doctor fails, show its output and point at `/dsh:setup`.
