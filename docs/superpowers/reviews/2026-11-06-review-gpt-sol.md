# Design review of v1 by GPT-6.1 Sol (kolezka-bootstrap:route-gpt-sol), 2026-11-06

Model output, kept verbatim as the record behind the "Review findings and what changed"
table in the design. Line references point at the v1 document and the installed dsh
0.2.1-rc.5 packages. "Verified" means checked against the installed source, not
reproduced at runtime.

## Verified findings, ranked

1. **P1: `ask_lead` cannot wait minutes with the proposed ACP mount.** The installed MCP client defaults to 60,000 ms and passes that deadline to `callTool` (`dsh-mcp-client/lib/index.js:140-146,765-788`). ACP constructs each session MCP client without a timeout override (`dsh-acp/lib/index.js:221-258`). The documented policy agrees (`dsh-mcp-client/README.md:61,85`). Increasing Claude-side timeouts does not change this deadline. Either expose a configurable deadline through ACP, or use a protocol whose individual tool calls finish within it.

2. **P1: Fresh-session lead-bridge construction requires an ID the caller does not have yet.** dsh generates the UUID inside `session/new`, mounts the supplied MCP servers, and only afterward returns the ID (`dsh-acp/lib/index.js:1213-1242`). Use a plugin-generated bridge token in the declaration, then bind it to the returned ACP ID before prompting.

3. **P1: `start` promises an acceptance acknowledgement ACP does not supply.** The ACP handler queues the message internally but returns its response only after completion (`dsh-acp/lib/index.js:837-863`). Define `start` as returning a locally allocated run handle after submission, with delivery initially unconfirmed. Never automatically replay the prompt.

## Inferred failure

4. **P1: Direct `ask` can strand its own permission/question request.** Return immediately with `status: waiting`, references and pending requests when interaction is required.

## Missing pieces

- Prompt serialization must include cancellation settlement. ACP cancellation is a notification; the slot clears during settlement (`dsh-acp/lib/index.js:1046-1050,1355-1357`). A question answer resolves the existing tool call; it must never become another prompt.
- Resume with a fresh socket is supported, but only as fresh connections: the implementation remounts the supplied servers (`dsh-acp/lib/index.js:712-723`). Old pending questions and run handles are invalidated, not recovered. Resolve the persisted cwd rather than defaulting to the new Claude project (`dsh-acp/lib/index.js:1257-1259`).
- Shutdown needs an owned-process deadline and escalation. EOF-driven shutdown is wired (`dsh-acp-app/lib/index.js:31-35`), but session close awaits activity before persistence and disposal (`dsh-acp/lib/index.js:963-990`). Resolve pending questions before awaiting close.
- Socket failure semantics are not yet a contract: framing limits, incremental UTF-8 decoding, backpressure, connection-scoped correlation IDs, duplicate handling, removal of pending requests on MCP cancellation or socket disconnect, a private 0700 directory, stale-path ownership checks, socket path-length handling.
- The tests need the actual timeout boundary: a real-dsh acceptance case answered after more than 60 seconds; cancel-then-immediate-follow-up; restart during a question; split and coalesced frames; disconnect after answer delivery but before its acknowledgement.

## Simplifications

- Make `start`/`follow`/`answer` the single interaction path. Keep `ask` only as a wrapper that returns on either completion or pending interaction.
- Remove undefined `keep?`. Clarify when completed and model-discovery sessions close; a retained idle session can prevent shutdown indefinitely.
