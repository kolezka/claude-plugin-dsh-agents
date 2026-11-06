import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DshAcpClient, PromptInFlight, CwdMismatch, ModelNotAvailable } from "../src/acp/client";
import { Journal } from "../src/journal";

type Api = Pick<DshAcpClient, "start" | "follow" | "answer" | "cancel" | "sessions" | "models" | "close">;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(overrides: Partial<Api> = {}) {
  const root = await mkdtemp("/tmp/dsha7-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new Journal(root);
  const calls: Array<{ method: string; args: unknown }> = [];
  const api: Api = {
    async start(args) { calls.push({ method: "start", args }); return { session: "s1", runId: "r1", status: "submitted" }; },
    async follow(args) { calls.push({ method: "follow", args }); return { status: "final", next: 2, events: [], pending: [], reply: "decoded reply" }; },
    async answer(args) { calls.push({ method: "answer", args }); },
    async cancel(args) { calls.push({ method: "cancel", args }); },
    async sessions(args) { calls.push({ method: "sessions", args }); return [{ session: "saved", cwd: "/saved", liveHere: false }]; },
    async models(args) { calls.push({ method: "models", args }); return { configOptions: null, hint: "Start a session" }; },
    async close(args) { calls.push({ method: "close", args }); },
    ...overrides,
  };
  const { createDshMcpServer } = await import("../src/mcp/server");
  const server = createDshMcpServer(api, journal);
  const client = new Client({ name: "test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(remote);
  await client.connect(local);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { root, journal, client, call, calls };
}

function decoded(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe("text");
  expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

test("Task7 exports an MCP factory", async () => {
  const module = await import("../src/mcp/server").catch(() => ({}));
  expect(typeof (module as any).createDshMcpServer).toBe("function");
});

test("Task7 tools/list exposes exactly nine tools with default and maximum limits", async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name).sort()).toEqual(["answer", "ask", "cancel", "close", "follow", "history", "models", "sessions", "start"]);
  const schema = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
  expect(schema("follow").waitSeconds).toMatchObject({ default: 90, maximum: 300, minimum: 0 });
  expect(schema("ask").timeoutSeconds).toMatchObject({ default: 600, maximum: 3600 });
  expect(schema("follow").after).toMatchObject({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
  expect(f.calls).toEqual([]);
});

test("Task7 validates bounds and safe cursors before invoking the ACP client", async () => {
  const f = await fixture();
  for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect((await f.call("follow", { session: "s1", runId: "r1", after })).isError).toBe(true);
  }
  expect((await f.call("follow", { session: "s1", runId: "r1", after: 0, waitSeconds: 301 })).isError).toBe(true);
  expect((await f.call("ask", { task: "test", timeoutSeconds: 3601 })).isError).toBe(true);
  expect(f.calls).toEqual([]);
  decoded(await f.call("follow", { session: "s1", runId: "r1", after: 0 }));
  expect(f.calls).toEqual([{ method: "follow", args: { session: "s1", runId: "r1", after: 0, waitSeconds: 90 } }]);
});

test("Task7 answer requires exactly one text or opaque permission choice", async () => {
  const f = await fixture();
  for (const input of [{}, { text: "yes", choice: "opaque:allow/42" }]) {
    expect((await f.call("answer", { session: "s1", requestId: "req", ...input })).isError).toBe(true);
  }
  expect(f.calls).toEqual([]);
  expect(decoded(await f.call("answer", { session: "s1", requestId: "req", choice: "opaque:allow/42" }))).toEqual({ ok: true });
  expect(decoded(await f.call("answer", { session: "s1", requestId: "q", text: "" }))).toEqual({ ok: true });
  expect(f.calls.map(c => c.args)).toEqual([{ session: "s1", requestId: "req", choice: "opaque:allow/42" }, { session: "s1", requestId: "q", text: "" }]);
});

test("Task7 ask returns pending immediately with a resumable run handle", async () => {
  const pending = [{ kind: "question" as const, session: "s1", requestId: "q", question: "Which?", createdAt: 1 }];
  const f = await fixture({ async follow() { return { status: "running", next: 7, events: [{ seq: 7, kind: "note" as const, text: "checkpoint", at: 1 }], pending }; } });
  const result = decoded(await f.call("ask", { task: "work" }));
  expect(result).toMatchObject({ session: "s1", runId: "r1", status: "waiting", next: 7, pending });
  expect(result.events).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "start")).toHaveLength(1);
  expect(f.calls.some(c => c.method === "cancel")).toBe(false);
});

for (const status of ["final", "cancelled", "error", "unknown"] as const) test(`Task7 ask stops on terminal ${status} and retains all events`, async () => {
  let count = 0;
  const seen: number[] = [];
  const f = await fixture({ async follow(args) {
    seen.push(args.after);
    return { status: ++count === 1 ? "running" : status, next: count, pending: [], events: [{ seq: count, kind: "note" as const, text: `event ${count}`, at: count }], ...(count === 2 ? { reply: "partial reply", error: status === "error" ? "failure details" : undefined } : {}) };
  } });
  const result = decoded(await f.call("ask", { task: "one task" }));
  expect(result).toMatchObject({ session: "s1", runId: "r1", status, next: 2, reply: "partial reply" });
  expect(result.events.map((e: any) => e.text)).toEqual(["event 1", "event 2"]);
  expect(seen).toEqual([0, 1]);
  expect(f.calls.filter(c => c.method === "start")).toHaveLength(1);
});

for (const progress of [false, true]) test(`Task7 ask observation failure retains recovery context ${progress ? "after progress" : "on first follow"}`, async () => {
  const error = Object.freeze(Object.assign(new Error("journal read failed: controlled diagnostic"), { name: "JournalReadError", code: "EIO", path: "/fixture/run.jsonl" }));
  const before = Object.getOwnPropertyDescriptors(error);
  const polls: Array<Parameters<Api["follow"]>[0]> = [];
  const updates: Array<Awaited<ReturnType<Api["follow"]>>> = progress ? [
    { status: "running", next: 4, events: [{ seq: 4, kind: "note", text: "first checkpoint" }], pending: [] },
    { status: "running", next: 9, events: [{ seq: 9, kind: "note", text: "second checkpoint" }], pending: [] },
  ] : [];
  const f = await fixture({ async follow(args) {
    polls.push(args);
    const update = updates.shift();
    if (update) return update;
    throw error;
  } });
  const response = await f.call("ask", { task: "submit exactly once", session: "s1" });
  expect(response.isError).toBe(true);
  const body = decoded(response);
  expect(body).toMatchObject({ session: "s1", runId: "r1", status: "unknown", next: progress ? 9 : 0, pending: [] });
  expect(body.events).toEqual(progress ? [
    { seq: 4, kind: "note", text: "first checkpoint" },
    { seq: 9, kind: "note", text: "second checkpoint" },
  ] : []);
  expect(body.error).toEqual({ name: "JournalReadError", message: "journal read failed: controlled diagnostic", code: "EIO", path: "/fixture/run.jsonl" });
  expect(body.recovery).toContain("follow/history");
  expect(body.recovery).toContain("unknown");
  expect(body.recovery).toContain("repair");
  expect(polls.map(({ session, runId, after }) => ({ session, runId, after }))).toEqual(progress ? [
    { session: "s1", runId: "r1", after: 0 },
    { session: "s1", runId: "r1", after: 4 },
    { session: "s1", runId: "r1", after: 9 },
  ] : [{ session: "s1", runId: "r1", after: 0 }]);
  expect(f.calls).toEqual([{ method: "start", args: { task: "submit exactly once", session: "s1" } }]);
  expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
});

for (const error of [new PromptInFlight("already-active", true), new ModelNotAvailable([{ id: "model", value: "fixture/model" }]), new Error("submission rejected before a handle exists")]) test(`Task7 ask pre-submission ${error.name} stays meaningful without invented handles`, async () => {
  let starts = 0;
  const f = await fixture({ async start() { starts++; throw error; } });
  const response = await f.call("ask", { task: "not submitted" });
  expect(response.isError).toBe(true);
  const body = decoded(response);
  expect(body).toEqual({ error: { ...error, name: error.name, message: error.message } });
  for (const key of ["session", "runId", "status", "next", "events", "pending", "recovery"]) expect(body).not.toHaveProperty(key);
  if (error instanceof PromptInFlight) expect(body.error).toMatchObject({ runId: "already-active", waiting: true });
  if (error instanceof ModelNotAvailable) expect(body.error.options).toEqual([{ id: "model", value: "fixture/model" }]);
  expect(starts).toBe(1);
  expect(f.calls).toEqual([]);
});

test("Task7 ask timeout is bounded without cancel, replay or busy polling", async () => {
  let follows = 0;
  const f = await fixture({ async follow() { follows++; return { status: "running", next: 3, events: [], pending: [] }; } });
  const before = Date.now();
  const result = decoded(await f.call("ask", { task: "keep working", timeoutSeconds: 0.08 }));
  expect(Date.now() - before).toBeLessThan(600);
  expect(result).toMatchObject({ session: "s1", runId: "r1", status: "running", next: 3, timedOut: true, events: [], pending: [] });
  expect(follows).toBeGreaterThan(0);
  expect(follows).toBeLessThan(10);
  expect(f.calls.map(c => c.method)).toEqual(["start"]);
});

test("Task7 ask timeout also bounds a slow follow without cancelling it", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<Api["follow"]>>>();
  cleanups.push(async () => { gate.resolve({ status: "final", events: [], pending: [], next: 1, reply: "late" }); });
  const f = await fixture({ follow: () => gate.promise });
  const result = decoded(await f.call("ask", { task: "slow poll", timeoutSeconds: 0.03 }));
  expect(result).toMatchObject({ session: "s1", runId: "r1", timedOut: true });
  expect(f.calls.map(c => c.method)).toEqual(["start"]);
});

test("Task7 MCP cancellation detaches ask without cancelling the dsh run", async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = Promise.withResolvers<Awaited<ReturnType<Api["follow"]>>>();
  const f = await fixture({ follow: () => { entered(); return gate.promise; } });
  const abort = new AbortController();
  const result = f.client.callTool({ name: "ask", arguments: { task: "detach" } }, undefined, { signal: abort.signal }).catch(error => error);
  await ready; abort.abort();
  expect(await result).toBeInstanceOf(Error);
  gate.resolve({ status: "final", events: [], pending: [], next: 2, reply: "late" });
  await Bun.sleep(20);
  expect(f.calls.map(c => c.method)).toEqual(["start"]);
});

test("Task7 history is explicitly labelled local journal and corruption is an error", async () => {
  const f = await fixture();
  await f.journal.append("saved", { t: "submitted", runId: "r", task: "journal control", at: 1 });
  await f.journal.append("saved", { t: "update", runId: "r", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "journal reply" } }, at: 2 });
  expect(decoded(await f.call("history", { session: "saved" }))).toMatchObject({ source: "dsh-agents journal", history: [{ role: "user", text: "journal control", at: 1 }, { role: "assistant", text: "journal reply", at: 2 }] });
  await Bun.write(join(f.root, "broken.jsonl"), "broken\n");
  const broken = await f.call("history", { session: "broken" });
  expect(broken.isError).toBe(true);
  expect(decoded(broken).error.name).toBe("JournalReadError");
  expect(f.calls).toEqual([]);
});

for (const error of [new PromptInFlight("open-run", true), new CwdMismatch("cwd does not match /saved"), new ModelNotAvailable([{ id: "model", value: "fixture/model" }]), new Error("dsh stderr: exact diagnostic")]) test(`Task7 preserves useful ${error.name} errors`, async () => {
  const f = await fixture({ async start() { throw error; } });
  const result = await f.call("start", { task: "work", session: "s1" });
  expect(result.isError).toBe(true);
  const body = decoded(result);
  expect(body.error).toMatchObject({ name: error.name, message: error.message });
  if (error instanceof PromptInFlight) expect(body.error).toMatchObject({ runId: "open-run", waiting: true });
  if (error instanceof ModelNotAvailable) expect(body.error.options).toEqual(error.options);
});

test("Task7 sessions and models have object envelopes and close/cancel target exact session", async () => {
  const f = await fixture();
  expect(decoded(await f.call("sessions", { cwd: "/saved", limit: 2 })).sessions).toEqual([{ session: "saved", cwd: "/saved", liveHere: false }]);
  expect(decoded(await f.call("models", { session: "s1" })).configOptions).toBeNull();
  expect(f.calls.some(c => c.method === "start")).toBe(false);
  expect(decoded(await f.call("cancel", { session: "s1" }))).toEqual({ ok: true });
  expect(decoded(await f.call("close", { session: "s1" }))).toEqual({ ok: true });
  expect(f.calls.slice(-2)).toEqual([{ method: "cancel", args: "s1" }, { method: "close", args: "s1" }]);
});

for (const stop of ["eof", "SIGTERM"] as const) test(`Task7 runtime owns lifetime and guards stdout until ${stop}`, async () => {
  const root = await mkdtemp("/tmp/dsha7-main-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const entry = join(import.meta.dir, "../src/mcp/main.ts");
  const child = Bun.spawn([process.execPath, "-e", `import {runMcp} from ${JSON.stringify(entry)}; const result = runMcp(); setTimeout(() => { console.log("not protocol"); process.stdout.write("direct noise\\n"); }, 10); process.exitCode = await result;`], { env: { ...process.env, DSH_HOME: root, TMPDIR: root, DSH_AGENTS_DSH_BIN: "/not-a-live-dsh" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  const stderr = new Response(child.stderr).text();
  let output = "";
  const reading = (async () => { for await (const bytes of child.stdout) output += new TextDecoder().decode(bytes); })();
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-test", version: "1" } } }) + "\n");
  await child.stdin.flush();
  const until = Date.now() + 2000;
  while (!output.includes('"id":1') && child.exitCode === null && Date.now() < until) await Bun.sleep(10);
  expect(output).toContain('"id":1');
  await Bun.sleep(30);
  expect(child.exitCode).toBeNull();
  if (stop === "eof") child.stdin.end(); else child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  await reading;
  const frames = output.trim().split("\n").map(line => JSON.parse(line));
  expect(frames).toHaveLength(1);
  expect(frames[0].result.serverInfo.name).toBe("dsh");
  expect(output).not.toContain("noise");
  expect(await stderr).not.toContain("startup failed");
});
