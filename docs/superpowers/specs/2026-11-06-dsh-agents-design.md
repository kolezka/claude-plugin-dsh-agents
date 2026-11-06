# dsh-agents: dsh sessions as Claude Code agents

Date: 2026-11-06. Status: draft for approval.

## Intent

Give a Claude Code session a way to hand any task to a dsh (DeepSeek Harness) session
and work with it as a peer: send a task, watch it work, answer its questions and
permission requests, send follow-ups into the same session, stop it, and read the
result back unchanged. The dsh session runs with the user's own dsh setup: the same
MCP servers, model providers and saved sign-ins the `web` profile has.

The user's stated reason is simply that they want dsh sessions available from Claude
Code. No narrower use case is implied; the plugin is general purpose.

The shape follows the `synergy` plugin in `~/Development/synergy-tui-login/claude`: an
MCP server owns the connection, thin Claude agents act as the bridge, a delegation skill
tells every session the agents exist, and slash commands cover direct use.

## Goals

- Any task, any cwd, from a Claude Code subagent, an agent-team teammate, or a direct
  slash command.
- Bi-directional. Three channels, all required:
  1. Claude to dsh: prompt, follow-up prompts in the same session, cancel, model and
     reasoning-effort choice.
  2. dsh to Claude, live: committed messages and thoughts, tool calls and results,
     permission requests that block until Claude answers.
  3. dsh to Claude, questions: dsh can ask the lead a question mid-run and wait for the
     answer, and can post a progress note the lead sees without stopping.
- Sessions persist on the dsh side. A session id reported once can be continued later,
  from the same or a new Claude session, and after the MCP server restarts.
- The dsh session sees the user's existing dsh MCP tools and models. Nothing the user
  configured in `~/.dsh/profiles/web/cordis.patch.yml` is lost.
- Faithful reporting. The bridge agent passes dsh's final reply through unchanged and
  keeps its own remarks separate, as the synergy agents do.

## Non-goals

- Running Claude Code plugins inside dsh. That is `claude-plugins-dsh`, already done.
- A GUI or panel. Progress is visible through the bridge agent's text and `follow`.
- Images, resource links, forks, transcript replay, extra workspace directories. The
  dsh ACP surface does not support most of these; text prompts are enough here.
- Managing dsh itself: installing, upgrading, editing profiles beyond what `/dsh:setup`
  needs to verify.

## Anti-goals

- Silently answering permission requests or questions on dsh's behalf without the
  bridge agent seeing them. The whole point is that Claude is in the loop.
- Sending the same task twice after an ambiguous failure. Synergy's rule carries over:
  once a session id and prompt are known to have reached dsh, never resend.
- Baking user-specific values (model names, provider ids, file paths under
  `/Users/me`) into the plugin. Defaults come from dsh and from configuration.
- Putting secrets into prompts, logs or the Outline record.

## Constraints and verified facts

Verified on this machine on 2026-11-06, dsh 0.2.1-rc.5 (global Bun install,
`~/.bun/bin/dsh`):

- `dsh --profile headless` is one-shot: no follow-up, no client-bound requests, and the
  shipped profile disables the credential store, so a plain run failed with
  `MISSING_CREDENTIAL` for the `cliproxyapi` route. Not suitable.
- `dsh --profile acp` serves the Agent Client Protocol (ACP v1) over stdio. The contract
  (`@deepseek-ai/dsh-acp/README.md`) offers `initialize`, `authenticate`, `session/new`,
  `session/list`, `session/resume`, `session/close`, `session/set_config_option`,
  `session/prompt`, `session/cancel`; agent-to-client `session/update` and
  `session/request_permission`. One prompt in flight per session. Several sessions per
  connection. No elicitation, no `session/load`, no modes, plans or terminals.
- The client declares MCP servers per session in `session/new` and `session/resume`
  (stdio with absolute command, or Streamable HTTP). dsh treats the ACP client as a
  trusted controller and connects them before the session is published; a connection
  failure rolls the session back.
- The user's MCP servers (two Slack, ClickHouse, Vulcan, Hindsight Inkitt, Outline),
  the model providers (`openai-codex`, `litellm`, `cliproxyapi`) and several setting rows
  live in the `web` profile's patch layer, not globally. The global
  `~/.dsh/cordis.patch.yml` adds `hindsight` and the `kolezka-bootstrap` adapter.
- `dsh --profile acp --dump-config --patch ~/.dsh/profiles/web/cordis.patch.yml`
  composes with all of the above present, credentials enabled, exit 0, and three
  warnings for web-only UI rows (`ui-settings-general`, `ui-chat`, `ui-theme`
  "not found"). The warnings are harmless.
- The shipped `acp` profile's default route row is `deepseek-official` /
  `deepseek-v4-flash`. The user's recent web sessions used `cliproxyapi` / `gpt-6.1-sol`.
- `@agentclientprotocol/sdk` 2.4.0 is on npm and usable from Bun. dsh's own reference
  client is `dsh-subagent-acp` in the dsh monorepo (not installed here).
- Project conventions: Bun, `bun test`, `bun check`; plugin files in English; no long
  dashes in anything written.

## Design

### Components

```
Claude Code lead
  |  subagent_type: dsh-agents:dsh        (bridge agent, Claude haiku)
  v
bridge agent  --MCP-->  dsh-agents MCP server (Bun, stdio, declared in .mcp.json)
                              |  ACP over stdio (one child process, lazily started)
                              v
                        dsh --profile acp --patch <web patch>
                              |  per session: MCP stdio server "lead" declared by us
                              v
                        dsh session  --MCP-->  lead-bridge (same Bun binary, bridge mode)
                                                   |  Unix socket back to the MCP server
                                                   v
                                          pending questions queue, read by follow,
                                          answered by answer
```

Four pieces, one package:

1. **MCP server** (`bin/dsh-agents mcp`). Started by Claude Code from `.mcp.json`. Owns
   the ACP connection and the per-session state. Exposes the tools below.
2. **ACP client**. Spawns `dsh --profile <profile> --patch <overlay>...` on first use,
   speaks ACP with `@agentclientprotocol/sdk` (a hand-written JSON-RPC client is an
   acceptable fallback if the SDK fights Bun), reconnects if the child dies, and shuts
   the child down after an idle period.
3. **lead-bridge** (`bin/dsh-agents lead-bridge --socket <path> --session <id>`). A tiny
   MCP stdio server dsh launches inside each session because we declare it in
   `session/new`. It exposes two tools to the dsh model and forwards them over a Unix
   socket to the MCP server, which pairs them with the owning session.
4. **Claude-side plugin files**: agents, skill, commands, setup.

### MCP tools (Claude side)

Names follow synergy's so the agent prompt and habits carry over. In Claude Code they
appear as `mcp__plugin_dsh-agents_dsh__<tool>`.

| Tool | Parameters | Returns |
|---|---|---|
| `start` | `task` (required), `session?`, `cwd?`, `model?`, `reasoningEffort?`, `keep?` | `{ session, runId }` as soon as dsh accepted the prompt |
| `follow` | `session`, `runId`, `after` (cursor, 0 first), `waitSeconds?` (default 90, max 300) | `{ status, events[], pending[], next, reply? }` |
| `answer` | `session`, `requestId`, and one of `text` or `choice` | `{ ok }` |
| `ask` | same as `start` plus `timeoutSeconds?` (default 600, max 3600) | the final reply, with `session` and `runId`; blocks |
| `cancel` | `session` | `{ ok }`; stops the in-flight prompt |
| `sessions` | `cwd?`, `limit?` | persisted sessions newest first, with `active` flag |
| `history` | `session`, `limit?` | user and assistant text of one session |
| `models` | none | the provider/model choices dsh advertises, with the current default |
| `close` | `session` | `{ ok }`; closes the live session, keeps it resumable |

Semantics:

- `start` with no `session` creates one with `session/new` in `cwd` (default: the MCP
  server's cwd, which Claude Code sets to the project dir). With `session`, it resumes
  the session if it is not live (`session/resume`) and then prompts. A `start` while a
  prompt is already in flight in that session is rejected with a clear error; the agent
  must `cancel` or wait.
- `follow` returns everything since cursor `after`: `session/update` items mapped to
  compact events (`text`, `thought`, `tool_call`, `tool_result`, `config`, `usage`), plus
  `pending`: open permission requests and open lead questions, each with a `requestId`,
  a `kind` (`permission` or `question`), the prompt text and the allowed choices.
  `status` is one of `running`, `waiting` (something in `pending` needs an answer),
  `final` (with `reply`), `cancelled`, `error`, `detached` (the ACP child died mid-run;
  the session is persisted but the run's fate is unknown). It waits up to `waitSeconds`
  for news before returning.
- `answer` resolves a pending item. For `permission`, `choice` is one of the option ids
  dsh sent (allow once, reject, and whatever else dsh offers). For `question`, `text` is
  the lead's answer; it becomes the tool result inside dsh. Answering an unknown or
  already answered id is an error, not a silent no-op.
- `ask` is `start` plus `follow` in one call for quick questions. A timeout does not
  cancel the run; the error names `session` and `runId` so the caller can `follow`.
- `cancel` calls `session/cancel`. Pending items of that session are resolved as
  rejected or cancelled so dsh's tools can finish.
- Session ids are dsh's ACP session ids, used verbatim.

### Permissions and questions

Both arrive the same way for the bridge agent: as `pending` items in `follow`. The
difference is who raised them.

- A **permission** comes from dsh's own approval policy via `session/request_permission`.
  The MCP server does not auto-answer by default. A per-server setting
  `permissions: ask | allow` exists; `allow` picks dsh's first allow option automatically
  and records that in the event stream, for users who want unattended runs.
- A **question** comes from the dsh model calling the `ask_lead` tool that our lead-bridge
  exposes. It carries `question` and optional `choices`. The call blocks inside dsh until
  `answer` arrives or the session is cancelled.
- `notify_lead(text)` is the non-blocking sibling: it appends a `note` event the bridge
  agent sees in `follow` and returns at once.

The lead-bridge is declared in `session/new` and `session/resume` as a stdio MCP server
with an absolute command (`bun <plugin>/src/lead-bridge.ts` or the built binary), the
socket path and the session id as arguments. The socket lives under
`$XDG_RUNTIME_DIR` or `$TMPDIR/dsh-agents-<uid>/<server-pid>.sock`, mode 0600. Messages
on it are newline-delimited JSON: `{ id, session, tool, args }` in, `{ id, result | error }`
out. If the socket is gone (MCP server exited), the tool returns an error to the dsh
model saying the lead is unreachable, so a run never hangs on a dead lead.

Because `session/resume` re-declares MCP servers, a session resumed by a new MCP server
process gets a lead-bridge pointing at the new socket. That is what makes questions work
after a Claude Code restart.

### Process lifecycle

- One `dsh --profile acp` child per MCP server, started on the first tool call that needs
  it. Stdout of the child is ACP only; stderr goes to a log file under
  `~/.dsh/state/dsh-agents/` and the last lines are included in error messages.
- Idle shutdown: after 30 minutes with no live session and no call, the child is asked
  to exit (stdin EOF, which the acp profile binds to a clean shutdown). It restarts on the
  next call.
- When Claude Code closes the MCP server (stdin EOF or SIGTERM), the server cancels
  in-flight prompts, closes live sessions with `session/close` so persistence is flushed,
  resolves pending questions with "lead gone", and then ends the child. Sessions stay
  resumable. Best effort within a few seconds, as in synergy.
- If the child dies mid-run, affected runs become `detached`; a later `start` or
  `sessions` restarts the child and `session/resume` brings the session back.

### Profile and configuration

Defaults aim at "works with the user's web setup, no editing":

| Setting | Env var | Default |
|---|---|---|
| dsh binary | `DSH_AGENTS_DSH_BIN` | `dsh` on PATH |
| profile | `DSH_AGENTS_PROFILE` | `acp` |
| patch overlays | `DSH_AGENTS_PATCH` (path list, `:` separated) | `$DSH_HOME/profiles/web/cordis.patch.yml` if it exists, else none |
| default model | `DSH_AGENTS_MODEL` (`provider/model`) | dsh's own default for the profile |
| default reasoning effort | `DSH_AGENTS_REASONING` | dsh's default |
| permissions | `DSH_AGENTS_PERMISSIONS` | `ask` |
| idle shutdown | `DSH_AGENTS_IDLE_MINUTES` | `30` |

`DSH_HOME` defaults to `~/.dsh` as in dsh. The env vars are set in `.mcp.json` via Claude
Code's `${VAR}` expansion or in the user's shell. `/dsh:setup` prints the effective
values and checks them (see below).

The web-patch overlay is the pragmatic answer to "dsh has its own MCP tools": the user's
tool and model configuration stays in one place and the acp profile borrows it. The
three "entry not found" warnings for web UI rows are expected and are filtered from
error output. If the user later moves shared rows to `~/.dsh/cordis.patch.yml`, the
overlay becomes unnecessary and can be set to empty.

### Claude-side plugin files

```
.claude-plugin/plugin.json      name dsh-agents
.mcp.json                       server "dsh": bin/dsh-agents mcp
bin/dsh-agents                  launcher (bun run src/cli.ts "$@")
src/cli.ts                      subcommands: mcp, lead-bridge, doctor
src/mcp/server.ts               MCP tools
src/acp/client.ts               ACP connection, session registry, event buffer
src/bridge/socket.ts            Unix socket protocol, pending queue
src/lead-bridge.ts              the MCP server dsh launches
agents/dsh.md                   the bridge agent (subagent or agent-team teammate)
skills/dsh-delegation/SKILL.md  tells sessions when and how to use the agents
commands/dsh/ask.md             /dsh:ask [--session <id>] [--model <p/m>] <task>
commands/dsh/sessions.md        /dsh:sessions [cwd]
commands/dsh/history.md         /dsh:history <session> [limit]
commands/dsh/models.md          /dsh:models
commands/dsh/status.md          /dsh:status   (is dsh reachable, which profile, which overlays)
commands/dsh/setup.md           /dsh:setup    (bun install, doctor, print config)
docs/                           README, protocol notes
test/                           bun test, with a fake ACP agent and a fake lead-bridge
```

**Agent `dsh`** mirrors `synergy.md`: Claude model `haiku` (user's call: the bridge only
relays, the thinking happens in dsh; the plan verifies the alias resolves through the
user's CLIProxyAPI gateway and falls back to `sonnet` if the catalog lacks Haiku), tools
limited to the dsh MCP tools plus `SendMessage` and `ToolSearch`.

Why a bridge agent at all: Claude Code's `subagent_type` always runs a Claude model with
tools; a foreign process cannot be registered as an agent. The bridge is what makes a
dsh session spawnable, parallel, and usable as an agent-team teammate. Direct calls
(`/dsh:ask`, or the lead calling `start`/`follow` itself) remain for quick questions. It writes one `dsh:` line per `follow` with news, answers `pending`
items from the brief when it can, otherwise asks the lead and relays the answer, never
resends a task, and reports once:

```
dsh (<provider/model>) replied:
<the reply, unchanged>
session: <id>
runId: <id>
Note: <the agent's own remark, if any>
```

For permission requests the agent's rule is: allow what the brief clearly covers; for
anything destructive or outside the brief, ask the lead before answering. The agent
never answers a question with a guess; if the brief does not contain the answer, it asks
the lead.

The same file carries an "In an agent team" section, as `synergy.md` does: keep one dsh
session for the whole time on the team, read lead messages between `follow` calls,
forward them as follow-up prompts or `answer`s, and report every result with
`SendMessage`. One agent type, no separate worker variant.

**Skill `dsh-delegation`** says: these agents exist, dsh cannot see the Claude
conversation so the brief must be self-contained, the session id lets you continue, and
when to use `/dsh:ask` instead.

**`/dsh:setup`** runs `bun install` in the plugin dir (after a marketplace install) and
then `bin/dsh-agents doctor`: finds `dsh`, prints its version, checks the profile
exists (creating it with `dsh --profile acp --help` if not, which is what dsh itself does),
dumps the composed config with the overlays and lists the MCP rows and providers it
found, and reports the model that will be used by default. It also runs one ACP
`initialize` round trip and reports the advertised models. It does not modify any dsh
file.

### Testing

- Unit tests with `bun test` against a **fake ACP agent**: a small Bun script speaking
  ACP over stdio that replays scripted `session/update` sequences, raises a
  `session/request_permission`, and calls the declared MCP server's `ask_lead` through a
  real MCP stdio client. This exercises `start`, `follow` cursors and statuses, `answer`
  for both kinds, `cancel`, `detached` on child death, and resume with a fresh socket.
- Lead-bridge protocol tests: socket missing, server gone mid-call, two sessions
  interleaved, malformed frames rejected loudly.
- One recorded end-to-end run against the real `dsh --profile acp` with the web overlay:
  a task that must call `ask_lead` before answering, answered via `answer`, and the final
  reply read back. Recorded in the task record, not asserted in CI.
- Regression tests for every bug found during review, following the project rule that a
  fix ships with a test that failed before it.

### Security notes

- The lead-bridge socket is per user, mode 0600, under a per-uid directory. Frames carry
  the session id and the server verifies it belongs to a live session before queuing.
- dsh runs with the user's full tools and the user's saved sign-ins. The plugin does not
  widen that; `permissions: ask` keeps Claude in the approval path by default.
- Replies from dsh are data. The agent prompt says so, as synergy's does.
- No tokens, keys or MCP headers are logged. The child's stderr log is 0600 and
  truncated at a size limit.

## Open questions settled as my calls

Marked so the user can overrule them while reading:

1. The bridge agent runs on `haiku` (user's choice), with `sonnet` as the fallback if the
   gateway catalog lacks Haiku. The dsh model does the work.
2. Default dsh model is dsh's own default for the profile, overridable by
   `DSH_AGENTS_MODEL`. The user's web sessions used `cliproxyapi/gpt-6.1-sol`; pinning
   that is a one-line config, not a plugin default.
3. Permissions default to `ask` (surfaced to the bridge agent), not auto-allow.
4. One agent type, `dsh`. More types would only make sense to pin different dsh models
   per agent; the `model` parameter in the brief covers that.
5. The web patch overlay is on by default when the file exists.
6. The MCP server is one process per Claude Code session, one dsh child per server.
   Several Claude sessions therefore run several dsh children; dsh persistence handles
   the shared session store (its own contract says other frontends sharing the store
   are untouched).

## Left to the builder

- Exact event schema inside `follow` and the cursor encoding.
- Whether to use `@agentclientprotocol/sdk` or a hand-written JSON-RPC client.
- Log rotation details, exact socket directory resolution order.
- Agent and skill prose, modelled on synergy's.
- How `doctor` filters the three expected overlay warnings.
