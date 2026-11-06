# Handoff: implement the dsh plugin with a GPT-only crew

Date: 2026-11-06. Written by the design session (Claude) for the implementation
orchestrator session, which runs on GPT-6.1 Sol by the user's choice.

## Your role

You are the lead orchestrator for implementing the plan below. You work only in this
worktree (`claude-plugin-dsh-agents.worktrees/impl`, branch `feat/dsh-plugin`). The
main checkout at `~/Development/claude-plugin-dsh-agents` is not yours to edit. You
delegate implementation and review to subagents, keep integration and final
verification in your own context, and never trust a worker's claim without rerunning
the check yourself.

## Inputs, read in this order

1. `docs/superpowers/specs/2026-11-06-dsh-agents-design.md` (approved design v2).
2. `docs/superpowers/plans/2026-11-06-dsh-agents.md` (10 tasks, TDD, one commit each).
3. `docs/superpowers/reviews/*.md` (what three reviewers found in v1; the traps live
   there).
4. `CLAUDE.md` in this repo (Bun conventions) and your global CLAUDE.md.
5. Outline task record `dsh-agents-plugin` under `raqz.pl/Koleżka/workspace/Tasks`
   (document id `015d2350-4432-41e8-9b90-da8316a37d3e`). Run `/load` first, checkpoint
   after every task with `/checkpoint`, write `/handoff` when you stop.
6. Hindsight initiative page `kp-6ec8578957fc48249882f8be6cf1052e`; search Hindsight
   before implementing anything that has to fit together.

## Routing rule from the user: GPT family only

Every subagent you dispatch must be one of these `subagent_type`s, with no per-call
`model` override:

| Work | Type |
|---|---|
| Implement a task with a clear spec (plan tasks 1, 2, 5, 8, 9) | `kolezka-bootstrap:route-gpt-terra` |
| Implement a task with concurrency or protocol work (plan tasks 3, 4, 6, 7, 10) | `kolezka-bootstrap:route-gpt-sol` |
| Review a task implemented by Terra | `kolezka-bootstrap:route-gpt-sol` |
| Review a task implemented by Sol | `kolezka-bootstrap:route-gpt-astra` |
| Exact-target lookups, small checks | `kolezka-bootstrap:route-gpt-luna` |
| Escalation after two failed fixes | `kolezka-bootstrap:route-gpt-astra` |

Do not use `kolezka-bootstrap:route-opus`, `kolezka-bootstrap:route-fable`,
`kolezka-bootstrap:route-deepseek-flash-edit`, or the built-in `Explore`, `Plan`,
`general-purpose`, `agents-def:*` types: they run Claude or DeepSeek. A reviewer must
never be the same model that wrote the code it reviews.

## Process

- Follow `superpowers:subagent-driven-development`: for each plan task, one
  implementer subagent, then one reviewer subagent from a different GPT model, fix
  findings, then you rerun the task's tests and `bun check` yourself before moving on.
- Tests first, as the plan writes them. Run the touched test file while iterating and
  the full `bun test` once per task before its commit.
- Conventional Commits, one commit per task, subject under 72 chars, no body unless
  the why is non-obvious. Never push. Never `git add -A`.
- No en dashes or em dashes in any file, comment or commit message. Bun APIs over
  Node ones where Bun has them. Comments only for non-obvious why.
- Brief every worker with: the task text from the plan, the exact files, the Interfaces
  block of its neighbours, the commands to run, a tool-call budget (about 60), and
  "run only the touched tests while iterating". Workers do not read the whole spec.
- Three failed fixes on one problem means the model is wrong: stop, write down what was
  falsified, and ask the user before a fourth attempt.
- Ask the user one question at a time, only when the answer changes what gets built.

## Task 10 needs the user

The real-dsh script (`scripts/e2e-real-dsh.ts`) you can run yourself: it starts a real
`dsh --profile acp` child with the user's web overlay. It talks to the user's model
gateway, so run it once, not in a loop. The interactive checks (spawning `dsh:dsh`
inside a Claude Code session, confirming the haiku alias through the gateway, the
subagent round trip) need the plugin installed in Claude Code; ask the user to run them
with you, or tell them exactly what to run and what to look for.

## Facts you should not rediscover

- dsh 0.2.1-rc.5, global Bun install at `~/.bun/bin/dsh`; profiles `acp`, `headless`,
  `web` exist under `~/.dsh/profiles`.
- dsh's MCP client times out a tool call after 60 000 ms; ACP mounts cannot raise it.
  That is why `ask_lead` polls.
- `@agentclientprotocol/sdk` 2.4.0 API: `ClientApp` with `onRequest`/`onNotification`,
  `connect(stream)` returning `{ agent: ClientContext }`, `ClientContext.request(method,
  params)`, `ndJsonStream(output, input)`; method names in `methods.agent.session.*` and
  `methods.client.session.*`. Types in `dist/v1/schema/types.gen.d.ts`. A scratch
  install exists at `/tmp/acp-sdk-probe/node_modules/@agentclientprotocol/sdk` for
  reading.
- `@modelcontextprotocol/sdk` 1.32.x: `McpServer.registerTool`, `StdioServerTransport`,
  `Client` + `StdioClientTransport`, `InMemoryTransport` for tests; `callTool(params,
  schema, { timeout })`.
- dsh permission requests carry only `toolCallId` plus options `allow-once` and
  `reject-once`; the tool context comes from the earlier `tool_call` update.

## When you are done

`bun test` and `bun check` green with the runner's own summary lines pasted into the
Outline record; `claude plugin validate .` passes; Task 10's recorded run in
`docs/e2e-2026-11-06.md`; a `/handoff` in Outline naming the branch head. Do not merge
to `main`; the user decides.
