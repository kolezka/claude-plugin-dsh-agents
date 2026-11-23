# Protocol notes

How the `dsh` MCP server talks to dsh, to the per-session lead bridge, and to its journal. This is for people changing the plugin; users only need the README.

## Processes

```
Claude Code ──stdio MCP──> bin/dsh-agents mcp ──stdio ACP v1──> dsh --profile acp [--patch ...]
                                  ^                                      │
                                  │ Unix socket (per session token)      │ stdio MCP (declared in session/new)
                                  └──────────── bin/dsh-agents lead-bridge
```

- One MCP server per Claude Code session, started by `.mcp.json`. It starts one `dsh --profile acp` child on the first tool call that needs it.
- The child's stdout carries ACP only. Its stderr goes to a 0600 log under `$DSH_HOME/state/dsh-agents/`, and the last lines appear in error messages.
- For each session the server declares one stdio MCP server, named `dsh_agents_lead`, in `session/new` or `session/resume`. dsh starts it as `bin/dsh-agents lead-bridge --socket <path> --token <token>`. It offers the dsh model three tools: `ask_lead`, `wait_lead` and `notify_lead`.

## ACP calls the server makes

| Plugin tool | ACP |
|---|---|
| `start` (new session) | `session/new` with `cwd` and the lead-bridge server, then `session/set_config_option` for model and reasoning effort when set, then `session/prompt` |
| `start` (existing session) | `session/resume` when the session is not live here, then the same as above |
| `follow` | none; reads the journal and the pending registry |
| `answer` | replies to the waiting `session/request_permission`, or wakes a waiting `ask_lead` |
| `cancel` | resolves pending items, then `session/cancel` |
| `sessions` | `session/list` (paged) |
| `models` | the session's advertised `configOptions` |
| `close` | `session/close` |

dsh's ACP surface is standard ACP v1: no elicitation, no plans, no terminals, and `set_config_option` accepts only model and reasoning effort.

## Permission requests

dsh asks `session/request_permission` with a `toolCallId` and options `allow-once` and `reject-once`. The request carries no tool arguments. dsh flushes its pending `session/update` notifications before it asks, so the server joins the request to the `tool_call` update it has already seen and attaches `title`, `kind` and `rawInput` as `context`. When no matching tool call was seen, `context` is `"missing"`.

- `permissions: ask` (default) puts the request in `pending` for `follow` and waits for `answer`.
- `permissions: allow` picks the allow option itself and journals it with `auto: true`.
- `cancel` and shutdown pick the reject option, or answer `cancelled` when there is none.

Which tool calls reach this path is dsh's decision, not the plugin's. dsh's `dsh-user-approval` row asks only when its policy is `ask`, and the policy follows `DSH_PERMISSION_MODE` (default preset in the web overlay: `danger-full-access`, policy `never`). `bin/dsh-agents doctor` prints both.

## Lead-bridge socket

- The socket lives in a 0700 directory: `$XDG_RUNTIME_DIR/dsha/` when set, else `$TMPDIR/dsha-<uid>/`. The socket file is 0600. A stale socket whose connect fails is removed before binding.
- Before `session/new` or `session/resume` the server makes a random 32-byte token. After ACP returns the session id, the token is bound to it. The token stops misrouting between sessions; it does not defend against code running as the same user.
- Frames are newline-delimited JSON, at most 1 MiB each.

```
-> { "hello": 1, "token": "<token>" }
-> { "id": "1", "tool": "ask_lead", "args": { "question": "...", "choices": ["a", "b"] } }
<- { "id": "1", "result": { "status": "pending", "questionId": "<id>", "hint": "Call wait_lead with questionId to keep waiting." } }
-> { "id": "2", "tool": "wait_lead", "args": { "questionId": "<id>" } }
<- { "id": "2", "result": { "status": "answered", "answer": { "text": "..." } } }
-> { "id": "3", "tool": "notify_lead", "args": { "text": "tests pass, starting the refactor" } }
<- { "id": "3", "result": { "ok": true } }
-> { "id": "4", "cancel": true }
```

- `ask_lead` registers a question and waits up to `bridgeWaitSeconds` (default 45). The wait stays under dsh's 60 s timeout for MCP tool calls, which cannot be raised for ACP-declared servers and is not reset by progress notifications. On timeout the reply is `pending` with the `questionId`, and the model calls `wait_lead` to keep waiting.
- Results are `answered`, `pending` or `cancelled`. An answer is consumed at most once.
- `notify_lead` journals a note that `follow` returns as a `note` event.
- A dropped connection ends that connection's waits, not the questions. If the socket is gone, the lead bridge returns an error so a run never hangs on a dead lead.

## Journal

One append-only JSONL file per session, `$DSH_HOME/state/dsh-agents/sessions/<session>.jsonl`, mode 0600. Record types:

| `t` | Fields |
|---|---|
| `submitted` | `runId`, `task` |
| `update` | `runId`, `update` (the ACP `session/update` payload) |
| `permission` | `runId`, `requestId`, `toolCallId`, `auto` |
| `question` | `runId`, `requestId`, `question` |
| `answer` | `requestId`, `answer` |
| `note` | `runId`, `text` |
| `settled` | `runId`, `status` (`final`, `cancelled`, `error`, `unknown`), `stopReason`, `error` |

Every record has `at` (epoch ms). The journal is the source for `follow` cursors, `history` and `reply`. Turns a session had outside this plugin, for example in the dsh web UI, are not in it.

## Run status

`follow` derives the status in this order: a `settled` record gives its status; a run that is no longer active without one is `unknown`; open pending items give `waiting`; new updates give `running`; otherwise `submitted`. `unknown` means the child died or the connection was lost mid-run. The session stays saved in dsh, and nothing resends the task.

## Lifecycle

- Create, resume, set config, prompt and close for one session run one at a time.
- A live session with no run in flight and nothing pending for `DSH_AGENTS_SESSION_IDLE_MINUTES` (30) is closed and stays resumable. With no live session and no call for `DSH_AGENTS_CHILD_IDLE_MINUTES` (30) the child stops.
- On shutdown (stdin EOF or SIGTERM): pending items resolve as cancelled, each live session gets `session/close` (5 s each, 15 s total), then the child's stdin closes, then SIGTERM after 5 s and SIGKILL after 2 s more.
- Two Claude Code sessions can both try to resume one dsh session. dsh's persistence lock decides; the loser reports `busy_elsewhere`.
