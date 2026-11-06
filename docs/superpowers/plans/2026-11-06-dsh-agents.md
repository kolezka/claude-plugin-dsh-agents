# dsh-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin named `dsh` whose Bun MCP server drives dsh (DeepSeek Harness) sessions over ACP, with a per-session lead-bridge so dsh can ask the Claude lead questions, and one haiku bridge agent `dsh:dsh`.

**Architecture:** `src/mcp/server.ts` exposes nine MCP tools over stdio and delegates to `src/acp/client.ts`, which owns one `dsh --profile acp` child (spawned via `Bun.spawn`, spoken to with `@agentclientprotocol/sdk`'s `ClientApp` over `ndJsonStream`), a per-session run state machine and a per-session JSONL journal. Every dsh session is created with a declared stdio MCP server, `src/lead-bridge.ts`, which connects back over a token-authenticated Unix socket (`src/bridge/socket.ts`) so `ask_lead`/`wait_lead`/`notify_lead` calls become pending items the Claude side reads with `follow` and resolves with `answer`.

**Tech Stack:** Bun 1.4 (runtime, `bun test`, `bun check`), TypeScript, `@agentclientprotocol/sdk` 2.4.0 (ACP client and, in tests, the fake agent), `@modelcontextprotocol/sdk` ^1.32 (MCP server for Claude, MCP server for dsh, MCP client in tests), `zod` for tool schemas.

**Spec:** `docs/superpowers/specs/2026-11-06-dsh-agents-design.md`

## Global Constraints

- Plugin name `dsh`; MCP server name `dsh`; tools appear in Claude Code as `mcp__plugin_dsh_dsh__<tool>`; agent `dsh:dsh`; commands `/dsh:<name>`.
- Bun only: `bun test`, `bun check`, `Bun.spawn`, `Bun.file`; no Node-only packages where Bun has the API. `node:net` is allowed for the Unix socket.
- `@agentclientprotocol/sdk` pinned to `2.4.0`; no hand-written ACP transport.
- dsh's MCP tool-call timeout is 60 000 ms and cannot be raised through ACP: `bridgeWaitSeconds` default `45`, config rejects values of 60 or more.
- `follow`: `waitSeconds` default 90, max 300. `ask`: `timeoutSeconds` default 600, max 3600.
- Idle defaults: `sessionIdleMinutes` 30, `childIdleMinutes` 30. Shutdown deadlines: 5 s per `session/close`, 15 s total, then stdin EOF, 5 s, SIGTERM, 2 s, SIGKILL.
- Socket directory mode 0700 at `$XDG_RUNTIME_DIR/dsha/` else `$TMPDIR/dsha-<uid>/`; socket path under 104 bytes; frames NDJSON, max 1 MiB.
- Journal and logs under `~/.dsh/state/dsh-agents/` (respecting `DSH_HOME`), mode 0600.
- Default overlay `$DSH_HOME/profiles/web/cordis.patch.yml` when it exists; the three expected `--dump-config` warnings (`ui-settings-general`, `ui-chat`, `ui-theme` "not found") are filtered from error output.
- Permission options from dsh are `allow-once` (kind `allow_once`) and `reject-once` (kind `reject_once`); `permissions: allow` selects by `kind` in `allow_once`, `allow_always`.
- English everywhere; no en or em dashes in any file; comments only for non-obvious why; Conventional Commits.
- Every bug fix ships with a test that failed before the fix.

## Review Focus

Inputs the spec implies but no happy path exercises. Each has a test pinned to the owning task.

1. The dsh child writes a non-JSON line to stdout (a stray warning). The connection must not die silently; the line is logged and the stream continues. (Task 6)
2. `session/request_permission` arrives before, or without, its `tool_call` update. The pending item still appears, marked `context: "missing"`, instead of being dropped or crashing the join. (Task 6)
3. `answer` for a run that already settled, or a `requestId` expired by resume. Must return a clear error, never succeed silently. (Task 4, Task 6)
4. `start` with `session` and a `cwd` that differs from the persisted cwd, or a session id dsh rejects as not resumable. Must surface dsh's error text, never create a new session instead. (Task 6)
5. A lead-bridge frame that is valid JSON but the wrong shape (`{ id: 1 }` with no `tool`, or `hello` with an unknown token). Connection closes with a logged reason; other connections unaffected. (Task 3)

---

### Task 1: Repository scaffold and plugin manifest

**Files:**
- Modify: `package.json`, `tsconfig.json`, `README.md`, `.gitignore`
- Delete: `index.ts`
- Create: `.claude-plugin/plugin.json`, `.mcp.json`, `bin/dsh-agents`, `src/cli.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `bin/dsh-agents <subcommand>` runs `bun run src/cli.ts "$@"` from the plugin root. `src/cli.ts` dispatches `mcp`, `lead-bridge`, `doctor`; unknown subcommand prints usage to stderr and exits 2.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli.test.ts
import { test, expect } from "bun:test";
test("cli rejects an unknown subcommand with usage on stderr", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "nope"], { stderr: "pipe", stdout: "pipe" });
  const code = await proc.exited;
  expect(code).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("usage: dsh-agents <mcp|lead-bridge|doctor>");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL, `src/cli.ts` not found.

- [ ] **Step 3: Scaffold**

`package.json`: name `dsh-agents`, `"type": "module"`, scripts `test: bun test`, `check: bun check`; dependencies `@agentclientprotocol/sdk@2.4.0`, `@modelcontextprotocol/sdk@^1.32.2`, `zod@^3.25`; devDependencies `@types/bun`. Run `bun install`. Delete `index.ts`.

`.claude-plugin/plugin.json`: `{ "name": "dsh", "description": "Hand tasks to dsh (DeepSeek Harness) sessions from Claude Code: MCP tools, the dsh:dsh bridge agent, /dsh:* commands and the dsh-delegation skill.", "author": { "name": "Mariusz Rakus" } }`.

`.mcp.json`: `{ "mcpServers": { "dsh": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents", "args": ["mcp"] } } }`.

`bin/dsh-agents` (POSIX sh, executable): resolve the plugin root with `cd -P "$(dirname "$0")/.." && pwd`, find `bun` on PATH or at `${BUN_INSTALL:-$HOME/.bun}/bin/bun`, `exec` it with `run "$root/src/cli.ts" "$@"`. Exit 127 with a one-line message if bun is missing.

`src/cli.ts`: `export async function main(argv: string[]): Promise<number>`; subcommands import lazily (`await import("./mcp/main.ts")` etc.) so `lead-bridge` starts fast. When run as the entry file, `process.exit(await main(Bun.argv.slice(2)))`.

- [ ] **Step 4: Run the test and type check**

Run: `bun test test/cli.test.ts && bun check`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitignore README.md .claude-plugin .mcp.json bin src test
git rm -q index.ts
git commit -m "build: scaffold the dsh plugin, launcher and cli"
```

---

### Task 2: Configuration

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    dshBin: string; profile: string; patches: string[]; model?: string; reasoningEffort?: string;
    permissions: "ask" | "allow"; bridgeWaitSeconds: number; sessionIdleMinutes: number;
    childIdleMinutes: number; dshHome: string; stateDir: string; socketDir: string;
  }
  export function loadConfig(env: Record<string, string | undefined>, fsExists: (p: string) => boolean): Config;
  export class ConfigError extends Error {}
  ```
  Env names and defaults exactly as the spec's "Profile and configuration" table; `stateDir` is `<dshHome>/state/dsh-agents`; `socketDir` is `$XDG_RUNTIME_DIR/dsha` when set, else `$TMPDIR/dsha-<uid>` (uid from `process.getuid()`), falling back to `/tmp` when `TMPDIR` is unset.

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
test("defaults: acp profile, web overlay when present, ask, 45 s wait", () => {
  const c = loadConfig({ HOME: "/h" }, (p) => p === "/h/.dsh/profiles/web/cordis.patch.yml");
  expect(c.profile).toBe("acp");
  expect(c.patches).toEqual(["/h/.dsh/profiles/web/cordis.patch.yml"]);
  expect(c.permissions).toBe("ask");
  expect(c.bridgeWaitSeconds).toBe(45);
  expect(c.stateDir).toBe("/h/.dsh/state/dsh-agents");
});
test("no overlay when the web patch is missing", () => {
  expect(loadConfig({ HOME: "/h" }, () => false).patches).toEqual([]);
});
test("DSH_AGENTS_PATCH splits on colon and DSH_HOME moves the state dir", () => {
  const c = loadConfig({ HOME: "/h", DSH_HOME: "/d", DSH_AGENTS_PATCH: "/a.yml:/b.yml" }, () => true);
  expect(c.patches).toEqual(["/a.yml", "/b.yml"]);
  expect(c.stateDir).toBe("/d/state/dsh-agents");
});
test("bridge wait of 60 or more is rejected", () => {
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_BRIDGE_WAIT_SECONDS: "60" }, () => false)).toThrow(ConfigError);
});
test("permissions accepts only ask or allow", () => {
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_PERMISSIONS: "yolo" }, () => false)).toThrow(ConfigError);
});
test("socket dir prefers XDG_RUNTIME_DIR", () => {
  expect(loadConfig({ HOME: "/h", XDG_RUNTIME_DIR: "/run/u" }, () => false).socketDir).toBe("/run/u/dsha");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `loadConfig` in `src/config.ts`**

Parse integers with `Number.parseInt`, reject NaN or non-positive with `ConfigError` naming the variable.

- [ ] **Step 4: Run tests**

Run: `bun test test/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: load dsh-agents configuration from the environment"
```

---

### Task 3: Lead-bridge socket server and pending queue

**Files:**
- Create: `src/bridge/frames.ts`, `src/bridge/pending.ts`, `src/bridge/socket.ts`, `test/bridge-frames.test.ts`, `test/bridge-socket.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // frames.ts
  export const MAX_FRAME_BYTES = 1_048_576;
  export type HelloFrame = { hello: 1; token: string };
  export type RequestFrame = { id: string; tool: "ask_lead" | "wait_lead" | "notify_lead"; args: Record<string, unknown> };
  export type CancelFrame = { id: string; cancel: true };
  export type ReplyFrame = { id: string; result: unknown } | { id: string; error: string };
  export class FrameDecoder { push(chunk: Uint8Array): Array<unknown>; }   // incremental UTF-8 + newline split; throws FrameTooLarge
  export function parseInbound(value: unknown): HelloFrame | RequestFrame | CancelFrame; // throws FrameShapeError
  export function encodeFrame(frame: object): Uint8Array;

  // pending.ts
  export type PendingItem =
    | { requestId: string; kind: "question"; session: string; question: string; choices?: string[]; createdAt: number }
    | { requestId: string; kind: "permission"; session: string; toolCallId: string; options: Array<{ optionId: string; kind: string; name: string }>; context?: { title?: string; kind?: string; rawInput?: unknown } | "missing"; createdAt: number };
  export type Answer = { text: string } | { choice: string } | { cancelled: true };
  export class PendingQueue {
    addQuestion(session: string, question: string, choices?: string[]): PendingItem;
    addPermission(session: string, toolCallId: string, options: PendingItem["options"], context: PendingItem["context"]): PendingItem;
    list(session: string): PendingItem[];
    answer(requestId: string, answer: Answer): void;                   // throws PendingError("unknown" | "answered")
    waitFor(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer | "timeout">; // delivered once
    cancelSession(session: string): void;                               // resolves every item with { cancelled: true }
    invalidateSession(session: string): void;                           // drops items without delivering (resume)
    onChange(listener: (session: string) => void): () => void;
  }

  // socket.ts
  export class BridgeSocketServer {
    constructor(opts: { socketDir: string; pending: PendingQueue; bridgeWaitMs: number; onNote: (session: string, text: string) => void; log: (line: string) => void });
    listen(): Promise<string>;                 // returns socket path; creates dir 0700, unlinks stale socket
    allocateToken(): string;                   // 32 random bytes, base64url
    bindToken(token: string, session: string): void;
    releaseSession(session: string): void;     // closes its connections, forgets its tokens
    close(): Promise<void>;
  }
  ```
  Tool semantics on the server side: `ask_lead` adds a question and `waitFor` up to `bridgeWaitMs`, replying `{ status: "answered", answer }`, `{ status: "pending", questionId, hint }` or `{ status: "cancelled" }`; `wait_lead` only waits; `notify_lead` calls `onNote` and replies `{ ok: true }`. A `CancelFrame` aborts that request's `waitFor` (the question stays pending). A disconnect aborts the connection's open waits.

- [ ] **Step 1: Write the frame tests**

```ts
// test/bridge-frames.test.ts
test("decoder reassembles split frames and splits coalesced ones", () => {
  const d = new FrameDecoder();
  expect(d.push(new TextEncoder().encode('{"a":1}\n{"b":'))).toEqual([{ a: 1 }]);
  expect(d.push(new TextEncoder().encode('2}\n'))).toEqual([{ b: 2 }]);
});
test("decoder decodes a multibyte character split across chunks", () => {
  const bytes = new TextEncoder().encode('{"q":"ż"}\n');
  const d = new FrameDecoder();
  expect(d.push(bytes.slice(0, 7))).toEqual([]);
  expect(d.push(bytes.slice(7))).toEqual([{ q: "ż" }]);
});
test("oversize frame throws", () => {
  const d = new FrameDecoder();
  expect(() => d.push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(97))).toThrow(FrameTooLarge);
});
test("parseInbound rejects a frame without tool or cancel", () => {
  expect(() => parseInbound({ id: "1" })).toThrow(FrameShapeError);
  expect(parseInbound({ id: "1", cancel: true })).toEqual({ id: "1", cancel: true });
});
```

- [ ] **Step 2: Write the socket tests** (raw `node:net` clients against `BridgeSocketServer`)

```ts
// test/bridge-socket.test.ts
test("hello with an unknown token closes the connection", ...);          // Review Focus 5
test("ask_lead returns pending after bridgeWaitMs and wait_lead gets the answer once", async () => {
  // bridgeWaitMs: 50; client sends hello(token bound to "s1"), ask_lead -> expect status pending with questionId
  // pending.answer(questionId, { text: "yes" }); client sends wait_lead -> status answered, answer "yes"
  // second wait_lead with the same questionId -> error "unknown"
});
test("ask_lead answered within the wait returns answered directly", ...);
test("cancel frame aborts the wait but keeps the question pending", ...);
test("two sessions interleave without cross-talk", ...);                  // tokens t1->s1, t2->s2; answers routed by requestId only within session
test("disconnect drops open waits; the question survives", ...);
test("duplicate request id on one connection is rejected", ...);
test("cancelSession resolves ask_lead with status cancelled", ...);
test("notify_lead calls onNote and replies ok", ...);
test("stale socket file is unlinked before listen", ...);
test("socket directory is created with mode 0700", ...);
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/bridge-frames.test.ts test/bridge-socket.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `frames.ts`, `pending.ts`, `socket.ts`**

Use `node:net.createServer` with `path`. Token: `crypto.getRandomValues` 32 bytes, base64url. Path length check: throw `ConfigError` if `socketDir + "/" + name` is 104 bytes or more; socket name `s-<pid>.sock`.

- [ ] **Step 5: Run tests**

Run: `bun test test/bridge-frames.test.ts test/bridge-socket.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bridge test/bridge-frames.test.ts test/bridge-socket.test.ts
git commit -m "feat: lead-bridge socket server with token binding and pending queue"
```

---

### Task 4: lead-bridge MCP server (the process dsh launches)

**Files:**
- Create: `src/lead-bridge.ts`, `src/bridge/client.ts`, `test/lead-bridge.test.ts`

**Interfaces:**
- Consumes: frame types from Task 3.
- Produces: `bun run src/cli.ts lead-bridge --socket <path> --token <token>` starts an MCP stdio server (`McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk`) named `lead` with tools:
  - `ask_lead` `{ question: string, choices?: string[] }` → text content with the JSON reply from the socket.
  - `wait_lead` `{ questionId: string }` → same.
  - `notify_lead` `{ text: string }` → `{ ok: true }`.
  `src/bridge/client.ts` exports `class BridgeClient { connect(path, token): Promise<void>; call(tool, args, signal): Promise<unknown>; }` which sends a `CancelFrame` when `signal` aborts and rejects with `LeadUnreachable` when the socket is missing or closes.

- [ ] **Step 1: Write the tests** (spawn the real lead-bridge process; drive it with `Client` + `StdioClientTransport` from `@modelcontextprotocol/sdk`; back it with a `BridgeSocketServer` from Task 3)

```ts
// test/lead-bridge.test.ts
test("tools/list shows ask_lead, wait_lead, notify_lead", ...);
test("ask_lead round trip through the socket returns the server's reply", ...);
test("missing socket makes ask_lead return an MCP error naming the lead as unreachable", ...);
test("client-side timeout cancels the call and the server receives a cancel frame", async () => {
  // callTool with options { timeout: 300 } while bridgeWaitMs is 5000; expect McpError RequestTimeout;
  // then expect the socket server to have observed a CancelFrame for that request id within 1 s
});
test("server closing the socket mid-call yields an error, not a hang", ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/lead-bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lead-bridge.ts` exports `export async function runLeadBridge(args: string[]): Promise<number>`. Parse `--socket` and `--token`; register the three tools with zod input schemas; forward `extra.signal` from the tool callback to `BridgeClient.call`. Never write to stdout except through the MCP transport.

- [ ] **Step 4: Run tests**

Run: `bun test test/lead-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lead-bridge.ts src/bridge/client.ts test/lead-bridge.test.ts
git commit -m "feat: lead-bridge MCP server that dsh sessions launch"
```

---

### Task 5: Journal

**Files:**
- Create: `src/journal.ts`, `test/journal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JournalRecord =
    | { t: "submitted"; runId: string; task: string; at: number }
    | { t: "update"; runId?: string; update: unknown; at: number }          // raw ACP SessionUpdate
    | { t: "permission"; runId?: string; requestId: string; toolCallId: string; auto?: boolean; at: number }
    | { t: "question"; runId?: string; requestId: string; question: string; at: number }
    | { t: "answer"; requestId: string; answer: unknown; at: number }
    | { t: "note"; runId?: string; text: string; at: number }
    | { t: "settled"; runId: string; status: "final" | "cancelled" | "error" | "unknown"; stopReason?: string; error?: string; at: number };
  export class Journal {
    constructor(dir: string);                                  // <stateDir>/sessions, created 0700; files 0600
    append(session: string, rec: JournalRecord): Promise<number>;   // returns the new line count (next cursor)
    read(session: string, after: number): Promise<{ records: JournalRecord[]; next: number }>;
    reply(session: string, runId: string): Promise<string>;    // agent_message_chunk text between submitted and settled of runId, joined in order
    history(session: string, limit?: number): Promise<Array<{ role: "user" | "lead" | "assistant"; text: string; at: number }>>;
  }
  ```

- [ ] **Step 1: Write the tests**

```ts
test("append returns increasing cursors and read(after) returns only later records", ...);
test("files are created 0600 inside a 0700 directory", ...);
test("reply joins agent_message_chunk text of one run and excludes thoughts and other runs", ...);
test("history lists user tasks, lead answers and assistant text in order", ...);
test("read of an unknown session returns no records and next 0", ...);
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** (append with `Bun.write`? No: use `node:fs/promises` `appendFile` with `mode: 0o600` so appends are atomic per line), **Step 4: Run tests**, **Step 5: Commit** `feat: per-session journal with cursors, reply and history`.

---

### Task 6: ACP client, session registry and run state machine

**Files:**
- Create: `src/acp/child.ts`, `src/acp/client.ts`, `src/acp/events.ts`, `test/fake-acp-agent.ts`, `test/acp-client.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `BridgeSocketServer`/`PendingQueue` (Task 3), `Journal` (Task 5).
- Produces:
  ```ts
  // child.ts
  export class DshChild {
    constructor(cfg: Pick<Config, "dshBin" | "profile" | "patches" | "stateDir">, log: (l: string) => void);
    start(): Promise<{ stream: Stream }>;     // Bun.spawn([dshBin, "--profile", profile, ...patches.flatMap(p => ["--patch", p])], { stdin: "pipe", stdout: "pipe", stderr: file }); stream = ndJsonStream(stdin, stdout)
    shutdown(): Promise<void>;                 // stdin.end(); 5 s; SIGTERM; 2 s; SIGKILL; await exited
    readonly exited: Promise<number>;
    lastStderrLines(n: number): string[];      // filtered of the three expected overlay warnings
  }

  // events.ts
  export type FollowEvent = { seq: number; kind: "text" | "thought" | "tool_call" | "tool_result" | "config" | "usage" | "note"; text?: string; toolCallId?: string; title?: string; status?: string; detail?: unknown };
  export function toFollowEvents(records: Array<{ seq: number; rec: JournalRecord }>): FollowEvent[];

  // client.ts
  export type RunStatus = "submitted" | "running" | "waiting" | "final" | "cancelled" | "error" | "unknown";
  export class DshAcpClient {
    constructor(deps: { cfg: Config; journal: Journal; pending: PendingQueue; bridge: BridgeSocketServer; spawnChild: () => DshChild; now?: () => number });
    start(a: { task: string; session?: string; cwd?: string; model?: string; reasoningEffort?: string }): Promise<{ session: string; runId: string; status: "submitted" }>;
    follow(a: { session: string; runId: string; after: number; waitSeconds?: number }): Promise<{ status: RunStatus; events: FollowEvent[]; pending: PendingItem[]; next: number; reply?: string; error?: string }>;
    answer(a: { session: string; requestId: string; text?: string; choice?: string }): Promise<void>;
    cancel(session: string): Promise<void>;
    sessions(a: { cwd?: string; limit?: number }): Promise<Array<{ session: string; cwd: string; liveHere: boolean }>>;
    models(session?: string): Promise<{ configOptions: unknown; source: "live" | "cached" } | { configOptions: null; hint: string }>;
    close(session: string): Promise<void>;
    shutdown(): Promise<void>;
  }
  export class PromptInFlight extends Error { constructor(public runId: string, public waiting: boolean) }
  ```
  Error classes: `PromptInFlight`, `CwdMismatch`, `BusyElsewhere`, `UnknownRequest`, `ModelNotAvailable` (carries the advertised options).

  Behaviour pinned by the spec, in `client.ts`:
  - Lazy child start; `ClientApp` with `onNotification("session/update", …)` appending `update` records (serialized per session) and `onRequest("session/request_permission", …)` which joins the last `tool_call` update with the same `toolCallId` (else `context: "missing"`), adds a pending permission (or auto-answers in `allow` mode by `kind`), and resolves when `PendingQueue.waitFor` delivers.
  - `start`: per-session mutex; token allocate → `session/new` or `session/resume` (cwd from `session/list`) with `mcpServers: [{ name: "lead", command: <abs bun>, args: [<abs cli.ts>, "lead-bridge", "--socket", path, "--token", token], env: [] }]` → bind token → if `model`/`reasoningEffort` given, `session/set_config_option` and verify `currentValue` → journal `submitted` → `agent.request("session/prompt", …)` not awaited; its settlement appends `settled`.
  - `follow` polls the journal with `pending.onChange` and a journal change signal, waking at most every 250 ms, until news or `waitSeconds`.
  - Idle timers and the shutdown order from Global Constraints.

- [ ] **Step 1: Write the fake ACP agent** (`test/fake-acp-agent.ts`, a Bun script using the SDK's `AgentApp` over `ndJsonStream(stdout, stdin)`). It reads a script from `FAKE_ACP_SCRIPT` (JSON path) describing, per prompt, the sequence of updates to emit, whether to raise a permission request (and for which toolCallId, before or after its `tool_call`), whether to call the declared MCP server's `ask_lead` then `wait_lead` through a real `@modelcontextprotocol/sdk` `Client` with `StdioClientTransport` and `{ timeout: 60_000 }` (configurable via `FAKE_ACP_TOOL_TIMEOUT_MS`), the final `stopReason`, and whether to exit abruptly mid-prompt. It implements `session/new`, `session/list`, `session/resume` (rejecting a cwd mismatch with the text `session cwd does not match`), `session/close`, `session/set_config_option` and `session/cancel` the way dsh does.

- [ ] **Step 2: Write the client tests**

```ts
// test/acp-client.test.ts   (each spawns the fake agent via spawnChild with a per-test script)
test("start returns submitted before the prompt settles; follow reaches final with the reply", ...);
test("start with model calls set_config_option first and fails with ModelNotAvailable on an unknown value", ...);
test("permission request becomes a pending item joined with its tool_call; answer allow-once lets the run finish", ...);
test("permission request without a tool_call update is pending with context missing", ...);   // Review Focus 2
test("ask_lead from the fake agent appears as a pending question; answer reaches the agent as the tool result", ...);
test("fake agent with a 300 ms tool timeout still gets the answer through wait_lead polling", ...);  // bridgeWaitMs 100
test("second start while a prompt is in flight throws PromptInFlight with waiting=true when a question is open", ...);
test("cancel resolves pending items first, then the run settles cancelled", ...);
test("child exit mid-prompt gives status unknown and the journal keeps the submitted record", ...);
test("resume after a client restart declares a new token and invalidates old pending items", ...);
test("start with a cwd different from the persisted one throws CwdMismatch with the agent's text", ...); // Review Focus 4
test("answer on a settled run throws UnknownRequest", ...);                                        // Review Focus 3
test("a non-JSON line on the child's stdout is logged and the connection keeps working", ...);    // Review Focus 1
test("permissions allow auto-answers by kind and journals auto: true", ...);
test("sessions merges session/list with liveHere", ...);
test("models returns live options for a live session and cached options otherwise", ...);
test("session idle timer closes the session; child idle timer shuts the child down", ...);         // now() injected
test("shutdown resolves pending, closes sessions, then ends the child within the deadlines", ...);
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/acp-client.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `child.ts`, `events.ts`, `client.ts`**

For Review Focus 1: wrap the child's stdout `ReadableStream` in a `TransformStream` that drops lines which are not valid JSON objects, logging them, before handing it to `ndJsonStream`.

- [ ] **Step 5: Run tests and type check**

Run: `bun test test/acp-client.test.ts && bun check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/acp test/fake-acp-agent.ts test/acp-client.test.ts
git commit -m "feat: ACP client with run state machine, lead-bridge binding and journal"
```

---

### Task 7: MCP server for Claude Code

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/main.ts`, `test/mcp-server.test.ts`

**Interfaces:**
- Consumes: `DshAcpClient` (Task 6).
- Produces: `export function createDshMcpServer(client: Pick<DshAcpClient, "start" | "follow" | "answer" | "cancel" | "sessions" | "models" | "close">, journal: Journal): McpServer` registering tools `start`, `follow`, `answer`, `ask`, `cancel`, `sessions`, `history`, `models`, `close` with zod schemas and the limits from Global Constraints; results as `structuredContent` plus a text rendering. `ask` loops `follow` until `final`, `pending` non-empty, or the timeout. `src/mcp/main.ts` wires config, journal, pending queue, socket server, client, `StdioServerTransport`, installs a stdout guard (as synergy's `installStdoutGuard`), and runs `client.shutdown()` on stdin end or SIGTERM.

- [ ] **Step 1: Write the tests** (connect an in-process MCP `Client` through `InMemoryTransport` to the server with a stub client object)

```ts
test("tools/list exposes the nine tools with the spec limits in their schemas", ...);
test("follow rejects waitSeconds above 300 and ask rejects timeoutSeconds above 3600", ...);
test("ask returns early with status waiting when the stub reports a pending item", ...);
test("answer requires exactly one of text or choice", ...);
test("history returns the journal with source dsh-agents journal", ...);
test("start error PromptInFlight maps to an MCP error naming the open runId", ...);
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**, **Step 4: Run tests and `bun check`**, **Step 5: Commit** `feat: dsh MCP server tools for Claude Code`.

---

### Task 8: doctor and the cli wiring

**Files:**
- Create: `src/doctor.ts`, `test/doctor.test.ts`, `test/fixtures/dump-config.txt` (captured from `dsh --profile acp --dump-config --patch ~/.dsh/profiles/web/cordis.patch.yml` with the user's URLs and headers replaced by placeholders)
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `export async function doctor(cfg: Config, run: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, acpInitialize: () => Promise<{ ok: boolean; error?: string }>): Promise<{ report: string; ok: boolean }>`. Report lines: dsh path and version, profile presence (creates it via `dsh --profile <p> --help` when missing), overlays, MCP rows found (`id` and `serverName`), provider/model rows, the acp default route, filtered warnings, ACP `initialize` result, effective config values.

- [ ] **Step 1: Write the tests**

```ts
test("doctor lists the six mcp rows and the providers from the fixture dump", ...);
test("doctor filters the three expected not-found warnings and reports any other warning", ...);
test("doctor reports a missing dsh binary as a failure with the install hint", ...);
test("doctor creates the profile dir with --help when missing and says so", ...);
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**, wire `doctor`, `mcp`, `lead-bridge` in `src/cli.ts`, **Step 4: Run `bun test` and `bun check`**, **Step 5: Commit** `feat: doctor subcommand that checks dsh, profile, overlays and ACP`.

---

### Task 9: Agent, skill, commands and README

**Files:**
- Create: `agents/dsh.md`, `skills/dsh-delegation/SKILL.md`, `commands/ask.md`, `commands/follow.md`, `commands/answer.md`, `commands/sessions.md`, `commands/history.md`, `commands/models.md`, `commands/status.md`, `commands/setup.md`, `docs/protocol.md`
- Modify: `README.md`
- Test: `test/plugin-files.test.ts`

**Interfaces:**
- Produces the Claude-facing surface. `agents/dsh.md` frontmatter: `name: dsh`, `model: haiku`, `color: cyan`, `tools:` the nine `mcp__plugin_dsh_dsh__*` names plus `SendMessage`, `ToolSearch`; body follows the spec's agent loop, report format and "In an agent team" section, modelled on `synergy.md`. Commands use `disable-model-invocation: true`; `setup` has `allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents install-deps)` and `Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor)`; add the `install-deps` branch to `bin/dsh-agents` (`bun install --frozen-lockfile --production`).

- [ ] **Step 1: Write the content tests**

```ts
test("agents/dsh.md pins model haiku and lists exactly the nine dsh tools plus SendMessage and ToolSearch", ...);
test("every command has disable-model-invocation true and a name matching its file", ...);
test("no file under agents, skills, commands, docs or README contains an en or em dash", ...);
test("plugin.json name is dsh and .mcp.json server is dsh", ...);
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Write the files**, **Step 4: Run `bun test test/plugin-files.test.ts` and `claude plugin validate .`** (expected: valid), **Step 5: Commit** `feat: dsh bridge agent, delegation skill and /dsh commands`.

---

### Task 10: Real-dsh end-to-end and gateway checks

**Files:**
- Create: `scripts/e2e-real-dsh.ts`, `docs/e2e-2026-11-06.md`

**Interfaces:**
- Consumes everything. Not part of `bun test`.

- [ ] **Step 1: Write `scripts/e2e-real-dsh.ts`**: starts `DshAcpClient` with the real config, `start`s the task "Call the lead tool ask_lead with the question 'Which word should I reply with?' and reply with exactly the answer you receive." in a temp cwd, `follow`s until `waiting`, sleeps 75 s, `answer`s with `pineapple`, `follow`s to `final`, prints the reply, the elapsed time and the number of `wait_lead` tool calls seen, then `close`s and `shutdown`s.

- [ ] **Step 2: Run it** with `bun run scripts/e2e-real-dsh.ts`
Expected: reply `pineapple`, at least one `wait_lead` call, exit 0. Record stdout and the exit code in `docs/e2e-2026-11-06.md`.

- [ ] **Step 3: Verify the haiku alias through the gateway**: install the plugin locally (`claude plugin install ./` or a marketplace entry), start a Claude Code session, spawn `dsh:dsh` with a brief that asks dsh to reply `pong`, confirm the agent's launch metadata shows a Haiku model and the report arrives. If the spawn fails on the model, change `agents/dsh.md` to `model: sonnet` and record why in `docs/e2e-2026-11-06.md`.

- [ ] **Step 4: Verify the subagent round trip**: same session, brief that makes dsh call `ask_lead`; confirm the bridge agent surfaces the question to the lead, the lead's answer reaches dsh, and the final report follows the spec's format. Record in `docs/e2e-2026-11-06.md`.

- [ ] **Step 5: Full suite and type check**

Run: `bun test && bun check`
Expected: all PASS, no type errors. Paste the runner's summary line into the task record.

- [ ] **Step 6: Commit**

```bash
git add scripts docs/e2e-2026-11-06.md agents
git commit -m "test: real dsh end-to-end run and gateway checks"
```

---

## Self-review notes

- Spec coverage: tools (Task 7), run handle and statuses (Task 6), 60 s poll protocol (Tasks 3, 4, 6), token binding (Tasks 3, 6), socket protocol (Task 3), lifecycle and shutdown (Task 6), journal (Task 5), permissions modes (Task 6), config table (Task 2), plugin files and `/dsh:setup` (Tasks 1, 8, 9), tests incl. the >60 s real run (Task 10). `doctor` creating the profile via `--help` (Task 8).
- Names used across tasks: `PendingQueue`, `PendingItem`, `BridgeSocketServer`, `Journal`, `JournalRecord`, `DshAcpClient`, `DshChild`, `FollowEvent`, `RunStatus`, `Config`, `loadConfig` are defined once and reused by those names.
- Review Focus items 1 to 5 each have a named test in Tasks 3, 4 and 6.
