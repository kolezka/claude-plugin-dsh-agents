# Design review of v1 by GPT-6 Astra (kolezka-bootstrap:route-gpt-astra), 2026-11-06

Model output, kept verbatim as the record behind the "Review findings and what changed"
table in the design. Line references point at the v1 document and the installed dsh
0.2.1-rc.5 packages.

## Verified findings, highest severity first

**1. P1: New-session bootstrap requires an ID that does not exist yet.**
The design passes dsh's session ID to lead-bridge in `session/new`. But dsh generates that ID inside `newSession`, mounts the supplied MCP servers, and only then returns the ID. The client cannot construct the proposed arguments in advance.
- Implementation: `dsh-acp/lib/index.js:1210-1242,693-704`
- Change: allocate an opaque bridge handle before creation, put that handle in the MCP declaration, then bind it to the returned ACP session ID before prompting.

**2. P1: `ask_lead` cannot wait indefinitely under the declared MCP mount.**
dsh's MCP client documents a 60-second tool-call timeout. ACP's mount translation supplies no `toolCallTimeoutMs` override. A human or busy lead can exceed that deadline.
- Contract: `dsh-mcp-client/README.md:55-61,83-85`; mount translation: `dsh-acp/lib/index.js:221-254`
- Change: settle the timeout strategy before building. Either arrange a supported longer timeout outside this standard declaration, or make questions durable and bounded rather than promising one indefinitely blocked tool call.

**3. P1: `start` promises an acceptance acknowledgment ACP does not provide.**
`session/prompt` returns its response after completion, not after admission. Returning after writing the request proves submission, not acceptance.
- Implementation: `dsh-acp/lib/index.js:796-863`
- Change: define `start` as returning a locally recorded submission handle. Distinguish submitted, observed-running, rejected and unknown outcome. Never automatically resend an ambiguous submission.

**4. P2: Permission requests do not contain the promised prompt text.**
dsh sends `sessionId`, `toolCallId` and allow/reject options. The operation name and arguments arrive separately in `tool_call` updates.
- Implementation: `dsh-acp/lib/index.js:1158-1179,592-600`
- Change: retain tool-call details keyed by session and tool-call ID, include them in pending permissions. Describe `permissions: ask` accurately: it handles approvals dsh raises; it does not force every dsh tool through approval.

## Inferred risks requiring design decisions

**5. P1: Blocking `ask` can strand its own approval/question.** The caller waits for the final result while dsh waits for that caller's `answer`. Return immediately from `ask` when intervention is required, or remove it.

**6. P1: Ownership and restart recovery are underspecified.** Two Claude processes can try to resume the same persisted session. `active` must not mean globally inactive merely because this server does not own the session. After a server crash, history alone cannot reconstruct outstanding run IDs. Define busy-owner errors, local versus global activity, durable submission records, and an explicit unknown-outcome recovery path.

**7. P2: Socket membership checks are weaker than connection binding.** Checking only that a supplied session ID is live permits a connected client to name another live session. Use a private 0700 runtime directory and bind each connection to its preallocated session capability. Expire pending questions when the originating MCP call disappears.

## Missing builder contracts

- Session metadata: resume requires the persisted cwd; listing excludes locally active sessions (`dsh-acp/lib/index.js:1250-1259,1298-1325`).
- Run state machine: serialize create/resume/configure/prompt per session; keep cancellation pending until ACP settles; reject new questions during closing; define `keep`, automatic close and event retention.
- Faithful reply assembly: preserve message IDs and text-block order, separate thoughts, define which assistant message is the final reply (`dsh-acp/lib/index.js:562-581`).
- Plugin discovery (inferred): the manifest name and the advertised `/dsh:*` namespace need reconciliation.

## Simplifications

- Drop blocking `ask`; make the slash command use the same `start`/`follow`/`answer` loop.
- Make `models` operate on an explicit session initially.
- Commit to the ACP SDK rather than leaving a hand-written transport fallback.

Recommendation: resolve findings 1 to 3 before implementation. Then require one authorized real integration test that waits beyond 60 seconds before answering, plus a normal-subagent round trip through the lead.
