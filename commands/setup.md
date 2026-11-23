---
description: Install the plugin's dependencies and check the dsh setup
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents install-deps), Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor)
disable-model-invocation: true
---

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents install-deps`. It runs `bun install --frozen-lockfile --production` in the plugin directory. If it fails, show the output and stop.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor`. It finds `dsh`, prints its version, checks the profile, composes the config with the patch overlays, lists the MCP servers, model routes, permission preset and approval policy, and runs one ACP handshake. It creates no session and changes no dsh file.
3. Show the doctor output, every warning and failure line as printed, and its exit code.
4. Print the effective settings and how to change them. They are environment variables read by the MCP server:

| Variable | Default |
|---|---|
| `DSH_AGENTS_DSH_BIN` | `dsh` on PATH |
| `DSH_AGENTS_PROFILE` | `acp` |
| `DSH_AGENTS_PATCH` | `$DSH_HOME/profiles/web/cordis.patch.yml` when it exists (`:` separated list) |
| `DSH_AGENTS_MODEL` | dsh's default for the profile (`provider/model`) |
| `DSH_AGENTS_REASONING` | dsh's default |
| `DSH_AGENTS_PERMISSIONS` | `ask` (or `allow` to approve dsh's requests automatically) |
| `DSH_AGENTS_BRIDGE_WAIT_SECONDS` | `45` (must stay under 60) |
| `DSH_AGENTS_SESSION_IDLE_MINUTES` | `30` |
| `DSH_AGENTS_CHILD_IDLE_MINUTES` | `30` |

`DSH_HOME` defaults to `~/.dsh`. After changing a variable, restart Claude Code so the MCP server picks it up.

If doctor warns that the permission preset is `danger-full-access`, explain that dsh then asks for few or no approvals, so `DSH_AGENTS_PERMISSIONS=ask` gates only what dsh raises.
