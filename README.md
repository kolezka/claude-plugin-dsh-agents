# dsh agents

A Claude Code plugin for handing tasks to dsh (DeepSeek Harness) sessions and getting the replies back. Claude Code stays the lead; a dsh session works as a peer that can ask the lead questions and request approvals while it runs.

## What you get

- **MCP tools** (`mcp__plugin_dsh_dsh__*`): `start`, `follow`, `answer`, `ask`, `cancel`, `sessions`, `history`, `models`, `close`.
- **The `dsh:dsh` agent.** A haiku bridge that passes a brief to dsh, follows the run, answers questions and approvals the brief covers, asks you about the rest, and reports the reply unchanged. Works as a subagent or as an agent team teammate.
- **The `dsh-delegation` skill**, which tells Claude when and how to delegate to dsh.
- **Commands:** `/dsh:ask`, `/dsh:follow`, `/dsh:answer`, `/dsh:sessions`, `/dsh:history`, `/dsh:models`, `/dsh:status`, `/dsh:setup`.
- **A lead bridge inside dsh.** Each session gets an MCP server named `dsh_agents_lead` with `ask_lead`, `wait_lead` and `notify_lead`, so the dsh model can ask Claude a question or post progress.

## Requirements

- [Bun](https://bun.sh) (developed on 1.4.4).
- dsh installed and on `PATH` (or set `DSH_AGENTS_DSH_BIN`), with a working `acp` profile. Tested with dsh `0.2.1-rc.5`; `doctor` warns on other versions.

## Install

Add the plugin to Claude Code from this repository, then run:

```
/dsh:setup
```

It installs the dependencies (`bun install --frozen-lockfile --production` in the plugin directory) and runs `bin/dsh-agents doctor`, which checks dsh, the composed profile, MCP server names and the approval settings.

## Use

Quick question, answer inline:

```
/dsh:ask Which files in src/ read DSH_AGENTS_PERMISSIONS?
```

Longer work, let Claude hand it to the agent:

```
Have dsh review src/journal.ts for crash safety and report what it finds.
```

Claude spawns `dsh:dsh` with a self-contained brief. The agent reports `dsh (<model>) replied:`, the reply, and the `session` and `runId`. Pass the session id back to continue in the same dsh session; `/dsh:sessions` lists them and `/dsh:history <session>` shows what this plugin recorded.

When dsh asks something the brief does not cover, the agent messages you. You can also answer yourself with `/dsh:answer <session> <requestId> <text>`.

## Approvals

dsh decides which tool calls need approval, through its permission preset. The plugin only answers the requests dsh raises. With dsh's `danger-full-access` preset (the default in the web overlay) dsh raises few or none, so `DSH_AGENTS_PERMISSIONS=ask` does not mean every action is checked. `/dsh:setup` and `/dsh:status` print the preset and policy in use. If a task must not change anything, say so in the brief.

## Configuration

Environment variables, read when the MCP server starts:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_AGENTS_DSH_BIN` | `dsh` | dsh executable |
| `DSH_AGENTS_PROFILE` | `acp` | dsh profile for the child process |
| `DSH_AGENTS_PATCH` | `$DSH_HOME/profiles/web/cordis.patch.yml` when it exists | colon-separated patch files; empty string for none |
| `DSH_AGENTS_MODEL` | profile default | default `provider/model` for new sessions |
| `DSH_AGENTS_REASONING` | profile default | default reasoning effort |
| `DSH_AGENTS_PERMISSIONS` | `ask` | `ask` routes approval requests to the lead, `allow` approves them automatically |
| `DSH_AGENTS_BRIDGE_WAIT_SECONDS` | `45` | how long `ask_lead` waits per call; must be under 60 |
| `DSH_AGENTS_SESSION_IDLE_MINUTES` | `30` | idle session close (sessions stay resumable) |
| `DSH_AGENTS_CHILD_IDLE_MINUTES` | `30` | idle dsh child shutdown |
| `DSH_HOME` | `~/.dsh` | dsh home; plugin state lives in `$DSH_HOME/state/dsh-agents/` |

## Limits

- dsh stops any MCP tool call after 60 s, and that limit cannot be raised for servers declared over ACP. `ask_lead` therefore returns `pending` after 45 s and the dsh model calls `wait_lead` to keep waiting.
- `history` shows only what this plugin recorded. Turns from the dsh web UI or other clients are not in it.
- A lost connection makes a run `unknown`. The session stays saved in dsh; the plugin never resends the task.
- Two Claude Code sessions resuming the same dsh session: dsh's lock decides, and the other gets `busy_elsewhere`.

## Development

```sh
bun install
bun test
bun check
bin/dsh-agents doctor
```

Protocol details for contributors: [docs/protocol.md](docs/protocol.md).
