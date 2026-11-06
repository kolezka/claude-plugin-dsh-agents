#!/usr/bin/env bun
import { AgentApp, ndJsonStream, RequestError, type SessionConfigOption, type SessionUpdate, type McpServer, type StopReason, type PermissionOption } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFile } from "node:fs/promises";

export type Script = {
  prompts?: Array<{ delay?: number; updates?: SessionUpdate[]; permission?: "before" | "after" | "missing"; permissionOptions?: PermissionOption[]; permissionGate?: string; question?: string; choices?: string[]; questionGate?: string; settleWithQuestion?: boolean; exit?: boolean; stopReason?: StopReason; cancelDelay?: number }>;
  sessions?: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>;
  stray?: boolean; stderr?: string; permissionDelay?: number; mountFailure?: boolean; rejectResume?: string; ignoreConfig?: boolean; closeGate?: string; hangClose?: boolean; hangEof?: boolean; ignoreTerm?: boolean;
};
const path = process.env.FAKE_ACP_SCRIPT!;
const script: Script = await Bun.file(path).json();
const trace = (method: string, params?: unknown) => appendFile(`${path}.trace`, JSON.stringify({ method, params }) + "\n");
const options = (): SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "fixture/default", options: [{ group: "fixture", name: "Fixture", options: [{ value: "fixture/default", name: "Default" }, { value: "fixture/alternate", name: "Alternate" }] }] },
  { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];
const saved = await Bun.file(`${path}.state`).exists() ? await Bun.file(`${path}.state`).json() as NonNullable<Script["sessions"]> : script.sessions ?? [];
const sessions = new Map(saved.map(s => [s.sessionId, { ...s, mcpServers: [] as McpServer[], configOptions: options() }]));
const persist = () => Bun.write(`${path}.state`, JSON.stringify([...sessions.values()].map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt }))));
const mcp = new Map<string, Client>();
async function mount(sessionId: string, servers: McpServer[]) {
  await mcp.get(sessionId)?.close();
  const declaration = servers[0];
  if (!declaration || !("command" in declaration)) throw RequestError.invalidParams(undefined, "stdio MCP server required");
  const transport = new StdioClientTransport({ command: script.mountFailure ? "/missing/fake-mcp-executable" : declaration.command, args: declaration.args, env: Object.fromEntries(declaration.env.map(e => [e.name, e.value])), stderr: "pipe" });
  const lead = new Client({ name: "fake-dsh", version: "1" });
  try { await lead.connect(transport); }
  catch (error) { await lead.close(); throw RequestError.internalError(undefined, `MCP mount failed: ${String(error)}`); }
  mcp.set(sessionId, lead);
}
const cancelled = new Set<string>();
let promptIndex = 0;
const app = new AgentApp();
app.onRequest("initialize", async ({ params }) => {
  await trace("initialize", params);
  if (script.stderr) await Bun.write(Bun.stderr, script.stderr);
  if (script.stray) await Bun.write(Bun.stdout, "startup chatter\n[]\nnull\n");
  return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } }, agentInfo: { name: "fake-dsh", version: "1" }, authMethods: [] };
});
app.onRequest("session/list", async ({ params }) => {
  await trace("session/list", params);
  const all = [...sessions.values()].filter(s => !params.cwd || s.cwd === params.cwd);
  const offset = Number(params.cursor ?? 0);
  return { sessions: all.slice(offset, offset + 1).map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt })), nextCursor: offset + 1 < all.length ? String(offset + 1) : undefined };
});
app.onRequest("session/new", async ({ params }) => {
  await trace("session/new", params);
  const sessionId = crypto.randomUUID();
  const session = { sessionId, cwd: params.cwd, mcpServers: params.mcpServers, configOptions: options() };
  await mount(sessionId, params.mcpServers);
  sessions.set(sessionId, session);
  await persist();
  return { sessionId, configOptions: session.configOptions };
});
app.onRequest("session/resume", async ({ params }) => {
  await trace("session/resume", params);
  if (script.rejectResume) throw RequestError.invalidParams(undefined, script.rejectResume);
  const session = sessions.get(params.sessionId);
  if (!session) throw RequestError.invalidParams("session not resumable");
  if (session.cwd !== params.cwd) throw RequestError.invalidParams(undefined, `session cwd does not match: ${params.cwd}`);
  session.mcpServers = params.mcpServers ?? [];
  await mount(params.sessionId, session.mcpServers);
  return { configOptions: session.configOptions };
});
app.onRequest("session/set_config_option", async ({ params }) => {
  await trace("session/set_config_option", params);
  const session = sessions.get(params.sessionId)!;
  const option = session.configOptions.find(o => o.id === params.configId)!;
  if (!script.ignoreConfig) option.currentValue = params.value as string;
  return { configOptions: session.configOptions };
});
app.onNotification("session/cancel", async ({ params }) => { cancelled.add(params.sessionId); await trace("session/cancel", params); });
app.onRequest("session/close", async ({ params }) => {
  await trace("session/close", params);
  if (script.closeGate) {
    await trace("close-gate", { sessionId: params.sessionId, name: script.closeGate });
    while (!await Bun.file(`${path}.release-${encodeURIComponent(script.closeGate)}`).exists()) await Bun.sleep(5);
  }
  if (script.hangClose) await new Promise(() => {});
  await mcp.get(params.sessionId)?.close(); mcp.delete(params.sessionId);
  return {};
});
app.onRequest("session/prompt", async ({ params, client }) => {
  cancelled.delete(params.sessionId);
  await trace("session/prompt", params);
  const step = script.prompts?.[promptIndex++] ?? {};
  if (step.exit) { await trace("exit"); process.exit(17); }
  const tool = { sessionUpdate: "tool_call" as const, toolCallId: "tool-exact-1", title: "Read fixture", kind: "read" as const, status: "pending" as const, rawInput: { path: "fixture.txt" } };
  if (step.permission) {
    if (step.permissionGate) {
      await trace("permission-gate", { sessionId: params.sessionId, toolCallId: tool.toolCallId });
      while (!await Bun.file(`${path}.release-${encodeURIComponent(step.permissionGate)}`).exists()) await Bun.sleep(5);
    }
    if (script.permissionDelay) await Bun.sleep(script.permissionDelay);
    if (step.permission === "after") await client.notify("session/update", { sessionId: params.sessionId, update: tool });
    const result = await client.request("session/request_permission", { sessionId: params.sessionId, toolCall: { toolCallId: tool.toolCallId }, options: step.permissionOptions ?? [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject once", kind: "reject_once" }] });
    await trace("permission-result", result);
    if (step.permission === "before") await client.notify("session/update", { sessionId: params.sessionId, update: tool });
  }
  if (step.question) {
    if (!mcp.has(params.sessionId)) await mount(params.sessionId, sessions.get(params.sessionId)!.mcpServers);
    const lead = mcp.get(params.sessionId)!;
    const timeout = Number(process.env.FAKE_ACP_TOOL_TIMEOUT_MS ?? 60_000);
    if (step.questionGate) {
      await trace("question-gate", { sessionId: params.sessionId, question: step.question });
      while (!await Bun.file(`${path}.release-${encodeURIComponent(step.questionGate)}`).exists()) await Bun.sleep(5);
    }
    let result = await lead.callTool({ name: "ask_lead", arguments: { question: step.question, ...(step.choices ? { choices: step.choices } : {}) } }, undefined, { timeout });
    const decode = () => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    let decoded = decode();
    await trace("ask-result", decoded);
    if (step.settleWithQuestion) return { stopReason: step.stopReason ?? "end_turn" };
    while (decoded.status === "pending") {
      result = await lead.callTool({ name: "wait_lead", arguments: { questionId: decoded.questionId } }, undefined, { timeout });
      decoded = decode(); await trace("wait-result", decoded);
    }
    await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(decoded) } } });
    await lead.close(); mcp.delete(params.sessionId);
  }
  if (step.delay) await Bun.sleep(step.delay);
  for (const update of step.updates ?? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture reply" } }]) await client.notify("session/update", { sessionId: params.sessionId, update });
  if (step.cancelDelay) await Bun.sleep(step.cancelDelay);
  return { stopReason: cancelled.has(params.sessionId) ? "cancelled" : step.stopReason ?? "end_turn" };
});
if (script.ignoreTerm) process.on("SIGTERM", () => { void trace("SIGTERM"); });
const output = new WritableStream<Uint8Array>({ write: async bytes => { await Bun.write(Bun.stdout, bytes); } });
const connection = app.connect(ndJsonStream(output, Bun.stdin.stream()));
await connection.closed;
await trace("EOF");
for (const lead of mcp.values()) await lead.close();
if (script.hangEof) await new Promise(() => { setInterval(() => {}, 1000); });
process.exit(0);
