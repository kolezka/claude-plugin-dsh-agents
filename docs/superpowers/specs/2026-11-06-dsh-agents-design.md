# dsh-agents: dsh sessions as Claude Code agents

Date: 2026-11-06, v2.1 2026-11-23. Status: v2.1, draft for approval. v1 was reviewed by three other model
families (GPT-6 Astra, GPT-6.1 Sol, DeepSeek Pro with and without reasoning); every
verified finding is folded in
and listed under "Review findings and what changed".

## Intent

Give a Claude Code session a way to hand any task to a dsh (DeepSeek Harness) session
and work with it as a peer: send a task, watch it work, answer its questions and
permission requests, send follow-ups into the same session, stop it, and read the
result back unchanged. The dsh session runs with the user's own dsh setup: the same
MCP servers, model providers and saved sign-ins the `web` profile has.

The user's stated reason is that they want dsh sessions available from Claude Code. No
narrower use case is implied; the plugin is general purpose.

The shape follows the `synergy` plugin in `~/Development/synergy-tui-login/claude`: an
MCP server owns the connection, one thin Claude agent acts as the bridge, a delegation
skill tells every session the agent exists, and slash commands cover direct use.

## Goals

- Any task, any cwd, from a Claude Code subagent, an agent-team teammate, or a direct
  slash command.
- Bi-directional. Three channels, all required:
  1. Claude to dsh: prompt, follow-up prompts in the same session, cancel, model and
     reasoning-effort choice.
  2. dsh to Claude, live: committed messages and thoughts, tool calls and results,
     permission requests that block dsh until Claude answers.
  3. dsh to Claude, questions: dsh can ask the lead a question mid-run and get the
     answer, and can post a progress note the lead sees without stopping.
- Sessions persist on the dsh side. A session id reported once can be continued later,
  from the same or a new Claude session, and after the MCP server restarts.
- The dsh session sees the user's existing dsh MCP tools and models. Nothing the user
  configured in `~/.dsh/profiles/web/cordis.patch.yml` is lost.
- Faithful reporting. The bridge agent passes dsh's final reply through unchanged and
  keeps its own remarks separate.

## Non-goals

- Running Claude Code plugins inside dsh. That is `claude-plugins-dsh`, already done.
- A GUI or panel. Progress is visible through the bridge agent's text and `follow`.
- Images, resource links, forks, transcript replay, extra workspace directories. The
  dsh ACP surface does not support most of these; text prompts are enough here.
- Managing dsh itself: installing, upgrading, editing profiles beyond what `doctor`
  needs to verify.
- Reading dsh's own persisted transcripts (`session.v4.jsonl.zstd`). History comes from
  the plugin's own journal.

## Anti-goals

- Silently answering permission requests or questions on dsh's behalf without the
  bridge agent seeing them. The whole point is that Claude is in the loop.
- Resending a prompt whose fate is unknown. Once a run handle exists, the prompt is
  never replayed automatically; the lead decides after reading the journal.
- Baking user-specific values (model names, provider ids, paths under `/Users/me`) into
  the plugin. Defaults come from dsh and from configuration.
- Putting secrets into prompts, logs, the journal or the Outline record.

## Constraints and verified facts

Verified on this machine on 2026-11-06, dsh 0.2.1-rc.5 (global Bun install,
`~/.bun/bin/dsh`). Line numbers refer to the installed packages under
`~/.bun/install/global/node_modules/@deepseek-ai/`.

- `dsh --profile headless` is one-shot: no follow-up, no client-bound requests, and the
  shipped profile disables the credential store (a plain run failed with
  `MISSING_CREDENTIAL` for the `cliproxyapi` route). Not suitable.
- `dsh --profile acp` serves ACP v1 over stdio (`dsh-acp/README.md:60-82`):
  `initialize`, `authenticate`, `session/new`, `session/list`, `session/resume`,
  `session/close`, `session/set_config_option`, `session/prompt`, `session/cancel`;
  agent-to-client `session/update` and `session/request_permission`. One prompt in
  flight per session. Several sessions per connection. No elicitation, no
  `session/load`, no modes, plans or terminals.
- `initialize` returns capabilities only; model choices (`configOptions`) come back
  from `session/new`, `session/resume` and `session/set_config_option`
  (`dsh-acp/lib/index.js:1183-1195, 1236-1242, 1288, 1332`).
- `session/new` generates the session id itself, mounts the declared MCP servers, and
  only then returns the id (`dsh-acp/lib/index.js:1210-1242`). The client cannot know
  the id while declaring the servers.
- `session/prompt` returns its response when the turn has completed, not when the
  prompt was admitted (`dsh-acp/lib/index.js:796-863`). The prompt slot is released
  during settlement, and `session/cancel` is a notification, not a confirmation that
  the slot is free (`dsh-acp/lib/index.js:1046-1050, 1355-1357`).
- `session/request_permission` carries `sessionId`, `toolCall: { toolCallId }` and
  exactly two options, `allow-once` (kind `allow_once`) and `reject-once` (kind
  `reject_once`). The tool's name and arguments arrive separately in `tool_call`
  updates (`dsh-acp/lib/index.js:1158-1180, 592-600`).
- Declared stdio MCP servers must have an absolute command; dsh mounts them with
  `failOnStartupError: true` and the session cwd, and passes **no tool-call timeout
  override** (`dsh-acp/lib/index.js:221-254`). dsh's MCP client times out each
  `tools/call` after **60 000 ms** by default (`dsh-mcp-client/README.md:61, 85`,
  `dsh-mcp-client/lib/index.js:140-146, 765-788`). A tool call that blocks longer is
  cancelled by dsh.
- `session/resume` remounts the MCP servers the resuming client declares
  (`dsh-acp/lib/index.js:712-723`), verifies the persisted cwd
  (`dsh-acp/lib/index.js:1257-1259`), and does not replay old updates. Session
  summaries from `session/list` carry the persisted cwd.
- `session/close` waits for activity to settle before persisting and disposing
  (`dsh-acp/lib/index.js:963-990`). The acp profile binds stdin EOF to a bounded
  shutdown (`dsh-acp-app/lib/index.js:31-35`).
- The user's MCP servers (two Slack, ClickHouse, Vulcan, Hindsight Inkitt, Outline),
  the model providers (`openai-codex`, `litellm`, `cliproxyapi`) and several setting
  rows live in the `web` profile's patch layer. The global `~/.dsh/cordis.patch.yml`
  adds `hindsight` and the `kolezka-bootstrap` adapter.
- `dsh --profile acp --dump-config --patch ~/.dsh/profiles/web/cordis.patch.yml`
  composes with all of the above present and credentials enabled, exit 0, with three
  warnings for web-only UI rows (`ui-settings-general`, `ui-chat`, `ui-theme` "not
  found"). Harmless.
- The shipped `acp` profile's default route row is `deepseek-official` /
  `deepseek-v4-flash`. The user's recent web sessions used `cliproxyapi` / `gpt-6.1-sol`.
- `@agentclientprotocol/sdk` 2.4.0 is on npm and usable from Bun.
- Claude Code namespaces plugin commands and agents by plugin name
  (`/<plugin>:<command>`, `subagent_type: <plugin>:<agent>`).
- Project conventions: Bun, `bun test`, `bun check`; plugin files in English; no long
  dashes in anything written.

## Design

### Components

```
Claude Code lead
  |  subagent_type: dsh:dsh                (bridge agent, Claude haiku)
  v
bridge agent  --MCP-->  dsh MCP server (Bun, stdio, declared in .mcp.json)
                              |  ACP over stdio (one child process, lazily started)
                              v
                        dsh --profile acp --patch <web patch>
                              |  per session: stdio MCP server "dsh_agents_lead" declared by us,
                              |  args: --socket <path> --token <bridge token>
                              v
                        dsh session  --MCP-->  lead-bridge (same Bun entry, bridge mode)
                                                   |  Unix socket, token-authenticated
                                                   v
                                          per-session journal + pending queue,
                                          read by follow, answered by answer
```

Four pieces, one package. The plugin is named `dsh`, so the user types `/dsh:ask` and
spawns `dsh:dsh`, and the MCP tools are `mcp__plugin_dsh_dsh__<tool>`. (My call; the
repository stays `claude-plugin-dsh-agents`.)

1. **MCP server** (`bin/dsh-agents mcp`). Started by Claude Code from `.mcp.json`. Owns
   the ACP connection, the per-session journal and the pending queue. Exposes the
   tools below.
2. **ACP client**. Spawns `dsh --profile <profile> --patch <overlay>...` on first use
   and speaks ACP with `@agentclientprotocol/sdk` (committed; no hand-written
   fallback, because cancellation and concurrent client-bound requests are core here).
3. **lead-bridge** (`bin/dsh-agents lead-bridge --socket <path> --token <token>`). A
   tiny MCP stdio server dsh launches inside each session because we declare it in
   `session/new` and `session/resume`. It exposes three tools to the dsh model and
   forwards them over the socket.
4. **Claude-side plugin files**: agent, skill, commands, setup.

### MCP tools (Claude side)

| Tool | Parameters | Returns |
|---|---|---|
| `start` | `task` (required), `session?`, `cwd?`, `model?`, `reasoningEffort?` | `{ session, runId, status: "submitted" }` right after the prompt was written to dsh |
| `follow` | `session`, `runId`, `after` (cursor, 0 first), `waitSeconds?` (default 90, max 300) | `{ status, events[], pending[], next, reply? }` |
| `answer` | `session`, `requestId`, and one of `text` or `choice` | `{ ok }` |
| `ask` | same as `start` plus `timeoutSeconds?` (default 600, max 3600) | returns at `final`, or as soon as something is `pending`, or at timeout; always with `session`, `runId`, `status` |
| `cancel` | `session` | `{ ok }`; resolves pending items, then `session/cancel` |
| `sessions` | `cwd?`, `limit?` | persisted sessions newest first (from `session/list`, with cwd and title), merged with the sessions live in this server, each flagged `liveHere` |
| `history` | `session`, `limit?` | user prompts, lead answers and committed assistant text from the plugin's journal, labelled `source: dsh-agents journal` |
| `models` | `session?` | the `configOptions` of that live session, else the options cached from the last `session/new` or `session/resume` this server did; when nothing is cached, says so and points at `start` |
| `close` | `session` | `{ ok }`; `session/close`, keeps it resumable |

Semantics:

- **Run handle.** `start` allocates `runId` locally, appends a `submitted` record to the
  journal, writes `session/prompt`, and returns. The ACP response is awaited in the
  background and resolves the run to `final` (stop reason `end_turn`), `cancelled`,
  `error` or, when the transport died first, `unknown`. Status `running` means at least
  one `session/update` for this run arrived. The journal record exists before the
  prompt leaves the process, so an ambiguous failure can never make the plugin resend.
- **New or resumed.** `start` with no `session` creates one with `session/new` in `cwd`
  (default: the MCP server's cwd, which Claude Code sets to the project dir). With
  `session`, it resumes the session if it is not live here, using the **persisted cwd
  from `session/list`**, never the Claude cwd; a `cwd` argument that differs is an
  error. Resume invalidates every old pending item and run handle of that session; they
  are not recovered.
- **One prompt in flight.** A `start` while this server has an unsettled prompt in that
  session is rejected with `prompt_in_flight`, including the open `runId` and whether
  it is `waiting` on a pending item. The slot is free only when the ACP prompt response
  has settled, not when `cancel` was sent. A question is never answered by sending a new
  prompt; only `answer` resolves it.
- **follow.** Returns journal events after cursor `after`: `text`, `thought`,
  `tool_call`, `tool_result`, `config`, `usage`, `note`, plus `pending`: open items,
  each `{ requestId, kind: "permission" | "question", ... }`. A permission item carries
  the joined tool-call context (title, kind, raw input from the matching `tool_call`
  update) and the two option ids dsh sent; when the context is missing it says so and
  the agent treats that as a reason to ask the lead. A question item carries the
  question text and optional choices. `status` is `submitted`, `running`, `waiting`
  (something in `pending`), `final` (with `reply`), `cancelled`, `error`, `unknown`
  (transport lost; run fate unknown; the session is persisted). `follow` waits up to
  `waitSeconds` for news before returning. Cursors are journal line numbers and stay
  valid across MCP server restarts.
- **answer.** For `permission`, `choice` is one of the option ids dsh sent (today
  `allow-once` or `reject-once`). For `question`, `text` is the lead's answer; it becomes
  the result of the dsh tool call. Answering an unknown, expired or already answered id
  is an error, not a silent no-op.
- **ask** is `start` plus `follow` in one call, but it returns as soon as `pending` is
  non-empty, so a single caller can never strand its own question. A timeout does not
  cancel the run.
- **cancel** first resolves every pending item of the session (permissions as
  `reject-once`, questions and waits with a `cancelled` result so the dsh tool call
  returns), then sends `session/cancel`, and keeps the run `running` until the ACP
  response settles to `cancelled`.
- **Model choice ordering.** When `start` carries `model` or `reasoningEffort`, the
  server calls `session/set_config_option`, waits for the returned state, checks that
  the requested value is now current (else fails `start` with the advertised options),
  and only then sends `session/prompt`. dsh pins the selection at prompt admission, so
  the order matters.
- **Session creation side effect.** `session/new` and `session/resume` connect every
  MCP server the profile and the overlay configure, plus our lead-bridge. A broken or
  slow user MCP server makes `start` slow or, for servers marked fail-on-startup,
  fail; the error names the server. This is dsh behaviour, surfaced, not hidden.
- **Reply assembly.** The `reply` of a run is the text of the assistant messages
  committed between this run's prompt and its ACP response, in message order, with
  message ids kept in the journal and thoughts kept separate.
- Session ids are dsh's ACP session ids, used verbatim.

### Questions within dsh's 60-second tool-call limit

dsh cancels any MCP tool call after 60 s and the ACP mount cannot raise that, so the
lead-bridge never blocks for long. It exposes three tools to the dsh model:

| Tool (dsh side) | Behaviour |
|---|---|
| `ask_lead(question, choices?)` | Posts the question, waits up to `bridgeWaitSeconds` (default 45, must stay under 60) for the answer. Returns `{ status: "answered", answer }` or `{ status: "pending", questionId, hint }`. The hint tells the model to call `wait_lead` and not to repeat the question. |
| `wait_lead(questionId)` | Waits up to `bridgeWaitSeconds` more. Same two outcomes, or `{ status: "cancelled" }` when the run was cancelled or the lead is gone. |
| `notify_lead(text)` | Appends a `note` event and returns at once. |

A question is delivered once: the first `wait_lead` after an answer gets it and the
item leaves the queue. If dsh cancels the tool call anyway (its own timeout or a turn
cancellation), the lead-bridge sees its MCP request cancelled and tells the server to
drop that wait, but the question itself stays pending until answered, expired by
`cancel`/`close`, or the session is resumed. Each dsh poll costs one short model step;
that is the price of staying inside the contract. If a later dsh exposes a timeout
override through ACP, `bridgeWaitSeconds` can go up without changing the protocol.

Permission requests are unaffected: `session/request_permission` is an ACP request to
the client, not an MCP tool call, so it has no 60 s limit on dsh's side.

### Lead-bridge socket protocol

- The MCP server listens on a Unix socket in a private directory it creates with mode
  0700: `$XDG_RUNTIME_DIR/dsha/` if set, else `$TMPDIR/dsha-<uid>/`. The path is kept
  short (macOS limits socket paths to 104 bytes). A stale socket file whose connect
  fails is unlinked before binding.
- Before `session/new` or `session/resume`, the server allocates a random 32-byte
  **bridge token** and declares the lead-bridge with `--socket <path> --token <token>`.
  After the ACP call returns the session id, the token is bound to it. A connection
  whose first frame carries an unknown or already-bound-elsewhere token is closed. The
  token is a capability for one session; it prevents misrouting between sessions, and
  that is all it claims. Same-uid code with filesystem access is not an adversary this
  design defends against.
- Frames are newline-delimited JSON, UTF-8 decoded incrementally, at most 1 MiB each.
  First frame: `{ hello: 1, token }`. Then requests `{ id, tool, args }` and replies
  `{ id, result } | { id, error }`. `id` is unique per connection; a duplicate is
  rejected. Cancelling the dsh tool call sends `{ id, cancel: true }`. A disconnect
  drops the connection's open waits (not the questions). Malformed frames close the
  connection with a logged error.
- If the socket is gone (MCP server exited), the lead-bridge returns an error to the
  dsh model saying the lead is unreachable, so a run never hangs on a dead lead.

### Process lifecycle

- One `dsh --profile acp` child per MCP server, started on the first tool call that
  needs it. Stdout is ACP only; stderr goes to a 0600 log under
  `~/.dsh/state/dsh-agents/` with size-based truncation, and the last lines are
  included in error messages, with the three expected overlay warnings filtered.
- Per-session serialization: create, resume, set config, prompt and close for one
  session run one at a time in the server.
- **Idle rules.** A live session with no in-flight prompt and no pending item for
  `sessionIdleMinutes` (default 30) is closed with `session/close` (it stays
  resumable). When no session is live and nothing has been called for
  `childIdleMinutes` (default 30), the child is shut down. Without the first rule a
  forgotten session would keep the child alive forever.
- **Shutdown** (Claude Code closes the server: stdin EOF or SIGTERM), in order and with
  deadlines: resolve every pending item as cancelled; `session/close` each live session
  with a 5 s deadline each and 15 s total; close the child's stdin; wait 5 s; SIGTERM;
  wait 2 s; SIGKILL; reap. Lead-bridge processes exit when dsh closes their stdin.
  Sessions stay resumable; the journal records what was still open.
- If the child dies mid-run, affected runs become `unknown`; the journal keeps their
  records. A later `start` or `sessions` restarts the child; `start` with the session
  id resumes it with a fresh token and socket.
- **Ownership.** `liveHere` is local knowledge. dsh refuses to resume a session that is
  live in the same process, but two MCP servers (two Claude sessions) can both try to
  resume the same persisted session; dsh's persistence lock decides and the losing
  server surfaces dsh's error as `busy_elsewhere`. The design does not promise
  cross-process exclusivity beyond that.

### Journal

One append-only JSONL file per session under `~/.dsh/state/dsh-agents/sessions/<id>.jsonl`
(0600): `submitted`, `update` (with the ACP `session/update` payload, message ids kept),
`permission`, `question`, `answer`, `note`, `settled`. It is the source for `follow`
cursors, `history` and `reply`, and it is what the lead reads to decide what to do
about an `unknown` run. Turns a session had outside this plugin (for example in the
web UI) are not in it, and `history` says so.

### Permissions

- `permissions: ask` (default): every `session/request_permission` dsh raises becomes a
  pending item; nothing is answered without the bridge agent. This handles the
  approvals dsh itself decides to raise; it does not force every dsh tool through
  approval. With the user's current default preset (`danger-full-access`) dsh raises
  few or none; see v2.1 change 4.
- `permissions: allow`: the server answers with the option whose `kind` is
  `allow_once` or `allow_always` and records that as a `permission` event with
  `auto: true`. For unattended runs.

### Profile and configuration

| Setting | Env var | Default |
|---|---|---|
| dsh binary | `DSH_AGENTS_DSH_BIN` | `dsh` on PATH |
| profile | `DSH_AGENTS_PROFILE` | `acp` |
| patch overlays | `DSH_AGENTS_PATCH` (`:` separated) | `$DSH_HOME/profiles/web/cordis.patch.yml` if it exists, else none |
| default model | `DSH_AGENTS_MODEL` (`provider/model`) | dsh's default for the profile |
| default reasoning effort | `DSH_AGENTS_REASONING` | dsh's default |
| permissions | `DSH_AGENTS_PERMISSIONS` | `ask` |
| bridge wait | `DSH_AGENTS_BRIDGE_WAIT_SECONDS` | `45` (rejected if 60 or more) |
| session idle | `DSH_AGENTS_SESSION_IDLE_MINUTES` | `30` |
| child idle | `DSH_AGENTS_CHILD_IDLE_MINUTES` | `30` |

`DSH_HOME` defaults to `~/.dsh`. The env vars are set in `.mcp.json` via `${VAR}`
expansion or in the user's shell. `/dsh:setup` prints the effective values.

The web-patch overlay is the pragmatic answer to "dsh has its own MCP tools": the user's
tool and model configuration stays in one place and the acp profile borrows it. If the
user later moves shared rows to `~/.dsh/cordis.patch.yml`, the overlay can be set to
empty.

### Claude-side plugin files

```
.claude-plugin/plugin.json      name "dsh"
.mcp.json                       server "dsh": bin/dsh-agents mcp
bin/dsh-agents                  launcher (bun run src/cli.ts "$@")
src/cli.ts                      subcommands: mcp, lead-bridge, doctor
src/mcp/server.ts               MCP tools
src/acp/client.ts               ACP connection, session registry, run state machine
src/journal.ts                  per-session JSONL journal, cursors
src/bridge/socket.ts            socket server, token binding, pending queue
src/lead-bridge.ts              the MCP server dsh launches
agents/dsh.md                   the bridge agent (subagent or agent-team teammate)
skills/dsh-delegation/SKILL.md  tells sessions when and how to use the agent
commands/ask.md                 /dsh:ask [--session <id>] [--model <p/m>] <task>
commands/follow.md              /dsh:follow <session> <runId>      (continue watching a run, shows pending items)
commands/answer.md              /dsh:answer <session> <requestId> <text | choice>
commands/sessions.md            /dsh:sessions [cwd]
commands/history.md             /dsh:history <session> [limit]
commands/models.md              /dsh:models [session]
commands/status.md              /dsh:status   (dsh reachable, profile, overlays, child state)
commands/setup.md               /dsh:setup    (bun install, doctor, print config)
docs/                           README, protocol notes
test/                           bun test, fake ACP agent, fake dsh MCP client with the 60 s policy
```

**Agent `dsh`** mirrors `synergy.md`: Claude model `haiku` (user's call: the bridge only
relays, the thinking happens in dsh; the plan verifies the alias resolves through the
user's CLIProxyAPI gateway and falls back to `sonnet` if the catalog lacks Haiku), tools
limited to the dsh MCP tools plus `SendMessage` and `ToolSearch`.

Why a bridge agent at all: Claude Code's `subagent_type` always runs a Claude model with
tools; a foreign process cannot be registered as an agent. The bridge is what makes a
dsh session spawnable, parallel, and usable as an agent-team teammate. Direct calls
(`/dsh:ask`, or the lead calling the tools itself) remain for quick questions.

The agent's loop: turn the brief into one self-contained task; `start`; `follow` until
`final`, writing one `dsh:` line per call with news; on `waiting`, answer from the brief
when the brief clearly covers it (for permissions: allow what the brief clearly covers,
ask the lead before anything destructive or outside it; for questions: never guess, ask
the lead when the brief lacks the answer) and relay the lead's answer with `answer`; on
`unknown`, report it with the session and run ids and do not resend; report once:

```
dsh (<provider/model>) replied:
<the reply, unchanged>
session: <id>
runId: <id>
Note: <the agent's own remark, if any>
```

The same file carries an "In an agent team" section, as `synergy.md` does: keep one dsh
session for the whole time on the team, read lead messages between `follow` calls,
forward them as follow-up prompts only after the current run settled, or as `answer`s,
and report every result with `SendMessage`. One agent type, no separate worker variant.

**Skill `dsh-delegation`** says: the agent exists, dsh cannot see the Claude
conversation so the brief must be self-contained, the session id lets you continue, and
when to use `/dsh:ask` instead.

**`/dsh:setup`** runs `bun install` in the plugin dir (after a marketplace install) and
then `bin/dsh-agents doctor`: finds `dsh`, prints its version, checks the profile exists
(creating it with `dsh --profile acp --help` if not, which is what dsh itself does),
dumps the composed config with the overlays (`--dump-config`) and lists the MCP rows,
the provider/model rows and the acp profile's default route it found there, and runs
one ACP `initialize` round trip to prove the child starts and speaks ACP. It creates no
session and does not modify any dsh file.

### Testing

- Unit tests with `bun test` against a **fake ACP agent**: a Bun script speaking ACP over
  stdio that replays scripted `session/update` sequences, raises
  `session/request_permission`, launches the declared lead-bridge and calls `ask_lead`
  and `wait_lead` through a real MCP stdio client **configured with dsh's 60 s tool-call
  timeout**, so the poll protocol is exercised, not assumed. Cases: `start` returns
  before the prompt response; `follow` cursors across a server restart; `answer` for
  both kinds; `cancel` then immediate follow-up `start` (rejected until settled, then
  accepted); child death mid-run gives `unknown`; resume with a fresh token and socket
  invalidates old pending items; `permissions: allow` picks by `kind`.
- Socket tests: missing socket, server gone mid-call, two sessions interleaved, wrong
  token, split and coalesced frames, oversize frame, duplicate id, disconnect after an
  answer was delivered but before its reply was read.
- One recorded end-to-end run against the real `dsh --profile acp` with the web
  overlay: a task that must call `ask_lead` before answering, with the lead answering
  **after more than 60 seconds**, then the final reply read back. Plus one ordinary
  subagent round trip where the bridge agent asks the lead and receives the answer
  while its own Agent invocation is still pending. Recorded in the task record, not
  asserted in CI.
- Regression tests for every bug found during review, following the project rule that a
  fix ships with a test that failed before it.

### Security notes

- Socket directory 0700, socket 0600, per-session capability token; see the protocol
  section for what that does and does not claim.
- dsh runs with the user's full tools and saved sign-ins. The plugin does not widen
  that; `permissions: ask` keeps Claude in the approval path by default.
- Replies from dsh are data. The agent prompt says so, as synergy's does.
- No tokens, keys or MCP headers are logged. Journal and logs are 0600.

## v2.1 changes: Docify and composed-config check (2026-11-23)

Checked against the DeepSeek Harness docs in Docify (`deepseek-harness@unknown`, built
from upstream master, downloaded 2026-11-13) and against the installed dsh 0.2.1-rc.5.
Where the two differ, the installed code wins, because that is what the plugin runs.
Passage ids are Docify ids.

1. **Lead-bridge server name is `dsh_agents_lead`, not `lead`.** dsh normalizes every
   ACP-declared server name to `[A-Za-z0-9_-]{1,32}` and rejects duplicates
   (`dsh-acp/lib/index.js:202-226`); mcp-client names must be unique within one
   registration scope (`p_1617cb047a05a48ff79d`). `lead` is short enough to collide with
   a user row, and dsh already reserves `lead` as the root agent name in its `subagent`
   tool (`p_e11ed2dc7bcddc4a80fa`), which would confuse the dsh model. The dsh-side tool
   names become `mcp__dsh_agents_lead__ask_lead`, `..._wait_lead`, `..._notify_lead`.
2. **The 60 s limit is confirmed and has no per-session way around it.** Docs show
   `toolCallTimeoutMs` on profile rows of `dsh-mcp-client` and `dsh-mcp-manager`
   (`p_1617cb047a05a48ff79d`, `p_33462fdbc2c6c3427bdb`), and the user's web patch already
   uses 120 000 for four servers. The ACP mount does not read it: it builds the client
   config from `transport`, `serverName`, `command`, `args`, `env`, `cwd` and
   `failOnStartupError` only (`dsh-acp/lib/index.js:228-240`). A profile row would raise
   the limit but is process-scoped and cannot carry a per-session token, so it would
   need one dsh child per session. Rejected; the 45 s poll stays.
3. **No keep-alive tricks.** dsh's MCP client calls `callTool` with a plain `timeout` and
   no `resetTimeoutOnProgress` (`dsh-mcp-client/lib/index.js:140-146`), so progress
   notifications do not extend a call. Tools with `execution.taskSupport: "required"`
   are refused (`dsh-mcp-client/lib/index.js:227-229`), and the ACP surface has no
   consumer for MCP resources or prompts (`dsh-acp/README.md`, Known Limitations). The
   lead-bridge exposes plain tools only.
4. **`permissions: ask` does not put every dsh action in front of Claude.** In the
   composed `acp` + web-overlay config, `dsh-permission-presets` has
   `defaultPreset: danger-full-access` with `approval: ask`, and `dsh-user-approval`
   derives its fallback policy from `DSH_PERMISSION_MODE` (`never` for
   `danger-full-access`). Approval requests come from dsh's own policy
   (`p_b2d1bf281d731869386b`, `p_e1207bf1ee24828c547c`); under a full-access sandbox they
   are rare, and under policy `never` dsh rejects without asking, so the plugin sees
   nothing. Changes: `doctor` prints the effective default preset, its sandbox and
   approval values, and `DSH_PERMISSION_MODE`; it warns when the default is
   `danger-full-access` or the policy is `never`. The agent and skill state that the
   lead approves what dsh asks about, not everything dsh does. The plugin does not
   change the user's preset; ACP `session/set_config_option` only covers `model` and
   `reasoning_effort` (`dsh-acp/README.md:70`).
5. **Permission context join is the documented contract, not a workaround.**
   `ApprovalRequest` deliberately omits tool arguments and links to the already streamed
   call through `callId` (`p_194c911158299869e068`). Keeps finding 4's join. No wait is
   needed: dsh drains queued session updates before it sends `session/request_permission`
   (`dsh-acp/lib/index.js:1158-1176`, `record.drainUpdates()`), so the `tool_call` update
   is already received. `context: missing` stays for calls without a streamed update.
6. **Outcome vocabulary.** The dsh model sees an approval as `allowed`, `rejected`,
   `cancelled` or `unavailable` through the owning tool's result
   (`dsh-acp/README.md`, Permission decisions; `p_ff1e3ae61adef8a5b880`). `cancel`
   answering pending permissions maps to `cancelled` when the ACP request is
   cancelled and to `reject-once` otherwise; the journal records which.
7. **`doctor` checks names and timeouts in the composed config.** It lists every
   enabled `serverName` with its `toolCallTimeoutMs`, fails if one equals
   `dsh_agents_lead`, and warns on duplicate enabled names (the current dump has two
   `outline` rows, one disabled, which is fine).
8. **Version pinning.** Docify tracks master; the plugin is built and tested against
   0.2.1-rc.5. `doctor` prints the dsh version and warns when it differs from the
   tested version recorded in `src/config.ts` (`TESTED_DSH_VERSION`). Every
   installed-code line reference in this spec is for that version.

### Open proposal, not adopted: HTTP lead-bridge

ACP lets a client declare a Streamable HTTP server with headers, and rc.5 mounts it
(`dsh-acp/lib/index.js:243-256`). The MCP server could serve the three lead tools itself
on a loopback port, with the per-session token in an `Authorization` header. That drops
the lead-bridge process, the socket directory and the custom frame protocol (and its
eight socket tests); MCP cancellation would come from the SDK. It gives up the 0700
Unix socket: a loopback port is reachable by any local user, so the token becomes the
only barrier. The 60 s limit is the same. Needs the user's decision before the plan
changes.

## Review findings and what changed

Verified against the installed dsh code unless marked inferred.

| # | Finding (reviewer) | Change in v2 |
|---|---|---|
| 1 | dsh's MCP client times out a tool call after 60 s and the ACP mount cannot override it; a blocking `ask_lead` dies (Astra, Sol) | `ask_lead` waits at most 45 s and returns `pending`; `wait_lead` polls; questions live in the server, not in the tool call |
| 2 | The session id does not exist before `session/new`, so the lead-bridge cannot be given it (Astra, Sol) | Per-session bridge token allocated beforehand, bound to the id afterwards; the token also authenticates the socket connection |
| 3 | `session/prompt` responds after completion; `start` cannot wait for "acceptance" (Astra, Sol) | `start` returns a local run handle after writing the prompt; journal record precedes the write; `unknown` status for lost transports; no automatic resend |
| 4 | Permission requests carry only `toolCallId` and two fixed options (Astra, DeepSeek) | Pending permission items join the `tool_call` context; `allow` mode picks by option `kind` |
| 5 | Blocking `ask` strands its own question (Astra, Sol, DeepSeek) | `ask` returns as soon as something is pending |
| 6 | `cancel` as a way to free a blocked tool call may deadlock (DeepSeek) | `cancel` resolves pending items first, then `session/cancel`; slot free only at settlement |
| 7 | Ownership and resume underspecified; `active` ambiguous (Astra, Sol) | `liveHere` flag, persisted cwd on resume, old handles invalidated, `busy_elsewhere` error, journal as the recovery record |
| 8 | Socket checks only the session id; directory and framing unspecified (Astra, Sol, DeepSeek) | Token per connection, 0700 dir, frame limits, ids, cancel frames, disconnect semantics |
| 9 | Event buffer and cursors not durable (DeepSeek) | Journal on disk; cursors are line numbers |
| 10 | Live-but-idle sessions defeat idle shutdown (Sol, DeepSeek) | Separate session idle rule before child idle rule |
| 11 | Shutdown order and deadlines missing (Sol, DeepSeek) | Explicit order: pending, close, EOF, SIGTERM, SIGKILL, with deadlines |
| 12 | Pending-session cache for `models` adds ownership rules (Astra, DeepSeek) | Dropped; `models` reads a live session or the last cached options |
| 13 | `keep` undefined (Sol) | Dropped |
| 14 | Command namespace is the plugin name, so `/dsh:*` needs plugin name `dsh` (Astra, inferred) | Plugin named `dsh` |
| 15 | Tests must hit the 60 s boundary and a real subagent round trip (Astra, Sol) | Added to the end-to-end cases and to the fake client's configuration |
| 16 | Cross-frontend resume leaves a dangling lead-bridge declaration (DeepSeek F4) | No change: ACP clients declare their own MCP servers at resume, so another frontend never inherits ours; noted here |
| 17 | Model choice must be set and confirmed before the prompt, or it applies to the next turn (DeepSeek Pro) | `start` orders `set_config_option`, state check, then `prompt` |
| 18 | Direct users have no command to answer a pending item (DeepSeek Pro) | `/dsh:follow` and `/dsh:answer` added |
| 19 | Creating a session connects all configured user MCP servers; a broken one can slow or fail it (DeepSeek Pro) | Named as a surfaced side effect of `start` |

## Decisions made for the user

Marked so the user can overrule them while reading:

1. The bridge agent runs on `haiku` (user's choice), `sonnet` as fallback if the gateway
   catalog lacks Haiku.
2. Default dsh model is dsh's own default for the profile, overridable by
   `DSH_AGENTS_MODEL`.
3. Permissions default to `ask`.
4. One agent type, `dsh`. The `model` parameter in the brief covers model variety.
5. Plugin name `dsh` (so `/dsh:ask`, `dsh:dsh`); repository name unchanged.
6. The web patch overlay is on by default when the file exists.
7. `history` is the plugin's journal, labelled as such.
8. One MCP server per Claude Code session, one dsh child per server.
9. `ask_lead` polling with a 45 s wait, as the only contract-safe way to wait for a
   human; revisit if dsh exposes a timeout override.

## Left to the builder

- Exact JSON shapes of journal records and `follow` events.
- Log truncation details, socket directory resolution order, token encoding.
- Agent and skill prose, modelled on synergy's.
- How `doctor` filters the three expected overlay warnings.
- The fake ACP agent's scripting format.
