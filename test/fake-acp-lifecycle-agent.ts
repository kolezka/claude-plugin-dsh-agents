#!/usr/bin/env bun
import { AgentApp, ndJsonStream, RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { appendFile, closeSync } from "node:fs";
import type { Script } from "./fake-acp-agent";

export type LifecycleScript = Script & {
  gates?: string[];
  closeStdout?: boolean;
  finishSetupOnEof?: boolean;
  catalogs?: string[];
  afterPromptUpdate?: string;
};
const path = process.env.FAKE_ACP_SCRIPT!;
const script: LifecycleScript = await Bun.file(path).json();
const trace = (method: string, params?: unknown) => new Promise<void>((resolve, reject) => {
  appendFile(`${path}.trace`, JSON.stringify({ method, params, pid: process.pid }) + "\n", error => error ? reject(error) : resolve());
});
async function gate(name: string) {
  if (!script.gates?.includes(name)) return;
  await trace("gate-enter", { name });
  while (!await Bun.file(`${path}.release-${encodeURIComponent(name)}`).exists()) await Bun.sleep(5);
  await trace("gate-release", { name });
}
const options = (model: string): SessionConfigOption[] => [{
  id: "model", name: "Model", category: "model", type: "select", currentValue: model,
  options: ["fixture/default", "fixture/alternate", "fixture/resumed"].map(value => ({ value, name: value })),
}];
const sessions = new Map((script.sessions ?? []).map(s => [s.sessionId, { ...s, live: false, configOptions: options("fixture/default") }]));
const cancelled = new Set<string>();
const setup = new Set<Promise<unknown>>();
let initialized = false;
let nextSession = 0;
let nextCatalog = 0;
let stdoutClosed = false;
const app = new AgentApp();
app.onRequest("initialize", async () => {
  await trace("initialize-enter");
  if (script.stderr) await Bun.write(Bun.stderr, script.stderr);
  await gate("initialize");
  initialized = true;
  await trace("initialize-done");
  return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } }, agentInfo: { name: "controlled-lifecycle-fake", version: "1" }, authMethods: [] };
});
app.onRequest("session/list", async ({ params }) => {
  await trace("session/list", { ...params, initialized });
  await gate("list");
  return { sessions: [...sessions.values()].map(({ sessionId, cwd }) => ({ sessionId, cwd })) };
});
for (const method of ["session/new", "session/resume"] as const) app.onRequest(method, ({ params }: { params: { sessionId?: string; cwd: string } }) => {
  const operation = (async () => {
    const requested = "sessionId" in params ? params.sessionId : undefined;
    if (requested && sessions.get(requested)?.live) throw RequestError.invalidParams(undefined, "session already active");
    const sessionId = requested ?? `lifecycle-session-${++nextSession}`;
    await trace(`${method}-enter`, { ...params, sessionId, initialized });
    await gate(method);
    const catalog = options(script.catalogs?.[nextCatalog++] ?? "fixture/default");
    // Match dsh: update ownership before any asynchronous trace write.
    sessions.set(sessionId, { sessionId, cwd: params.cwd, live: true, configOptions: catalog });
    await trace(`${method}-done`, { sessionId, cwd: params.cwd });
    return method === "session/new" ? { sessionId, configOptions: catalog } : { configOptions: catalog };
  })();
  setup.add(operation);
  void operation.finally(() => setup.delete(operation)).catch(() => {});
  return operation;
});
app.onRequest("session/set_config_option", async ({ params }) => {
  await trace("session/set_config_option-enter", params);
  await gate("config");
  const session = sessions.get(params.sessionId)!;
  session.configOptions[0]!.currentValue = params.value as string;
  await trace("session/set_config_option-done", params);
  return { configOptions: session.configOptions };
});
app.onNotification("session/cancel", async ({ params }) => {
  cancelled.add(params.sessionId);
  await trace("session/cancel", params);
});
app.onRequest("session/close", async ({ params }) => {
  sessions.get(params.sessionId)!.live = false;
  await trace("session/close", params);
  await gate("close");
  if (script.hangClose) await new Promise(() => {});
  return {};
});
app.onRequest("session/prompt", async ({ params, client }) => {
  cancelled.delete(params.sessionId);
  const task = params.prompt.find(p => p.type === "text");
  const identity = { sessionId: params.sessionId, task: task?.type === "text" ? task.text : "" };
  await trace("session/prompt", { ...params, ...identity });
  await gate(`prompt-enter:${identity.task}`);
  await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `reply:${identity.task}` } } });
  await trace("prompt-update", identity);
  await gate(`prompt-update:${identity.task}`);
  if (script.afterPromptUpdate) await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: script.afterPromptUpdate } } });
  if (script.closeStdout && !stdoutClosed) setTimeout(() => {
    stdoutClosed = true;
    closeSync(1);
    void trace("stdout-closed", identity);
  }, 30);
  return { stopReason: cancelled.has(params.sessionId) ? "cancelled" : "end_turn" };
});
if (script.ignoreTerm) process.on("SIGTERM", () => { void trace("SIGTERM"); });
const connection = app.connect(ndJsonStream(new WritableStream({ write: async bytes => {
  if (!stdoutClosed) await Bun.write(Bun.stdout, bytes);
} }), Bun.stdin.stream()));
await connection.closed;
await trace("EOF");
if (script.finishSetupOnEof) {
  await Promise.allSettled([...setup]);
  await Bun.sleep(100);
}
if (script.hangEof) await new Promise(() => { setInterval(() => {}, 1000); });
process.exit(0);
