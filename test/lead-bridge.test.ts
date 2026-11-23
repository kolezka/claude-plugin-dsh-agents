import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { BridgeClient, LeadUnreachable } from "../src/bridge/client";
import { encodeFrame, FrameDecoder, parseInbound, type RequestFrame } from "../src/bridge/frames";
import { PendingQueue, type PendingItem } from "../src/bridge/pending";
import { BridgeSocketServer } from "../src/bridge/socket";

const root = resolve(import.meta.dir, "..");
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No result within ${ms} ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function tempDir() {
  const dir = await mkdtemp("/tmp/dsh-lead-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(bridgeWaitMs = 5000) {
  const pending = new PendingQueue();
  const notes: Array<[string, string]> = [];
  const server = new BridgeSocketServer({
    socketDir: await tempDir(), pending, bridgeWaitMs,
    onNote: (session, text) => notes.push([session, text]),
    log: () => {},
  });
  cleanups.push(() => server.close());
  const path = await server.listen();
  const token = server.allocateToken();
  server.bindToken(token, "session-1");
  return { pending, server, notes, path, token };
}

async function launch(path: string, token: string) {
  const client = new Client({ name: "lead-bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/cli.ts", "lead-bridge", "--socket", path, "--token", token],
    cwd: root, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  cleanups.push(async () => {
    await client.close();
    expect(stderr).not.toContain(token);
  });
  await within(client.connect(transport), 3000);
  expect(client.getServerVersion()?.name).toBe("dsh_agents_lead");
  return client;
}

function decoded(result: Awaited<ReturnType<Client["callTool"]>>) {
  const reply = result as CallToolResult;
  expect(reply.isError).not.toBe(true);
  expect(reply.content).toHaveLength(1);
  const content = reply.content[0];
  if (content?.type !== "text") throw new Error("Expected text content");
  return JSON.parse(content.text);
}

function toolError(result: Awaited<ReturnType<Client["callTool"]>>) {
  const reply = result as CallToolResult;
  expect(reply.isError).toBe(true);
  const content = reply.content[0];
  if (content?.type !== "text") throw new Error("Expected error text");
  return content.text;
}

function nextItem(pending: PendingQueue): Promise<PendingItem> {
  return within(new Promise((resolve) => {
    const unsubscribe = pending.onChange(() => {
      const item = pending.list("session-1")[0];
      if (item) { unsubscribe(); resolve(item); }
    });
    cleanups.push(async () => unsubscribe());
    const item = pending.list("session-1")[0];
    if (item) { unsubscribe(); resolve(item); }
  }));
}

class RawPeer {
  readonly closed: Promise<void>;
  private frames: unknown[] = [];
  private readers: Array<(frame: unknown) => void> = [];

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
    socket.on("error", (error) => { throw error; });
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const reader = this.readers.shift();
        if (reader) reader(frame);
        else this.frames.push(frame);
      }
    });
  }

  next() {
    return within(this.frames.length ? Promise.resolve(this.frames.shift()) : new Promise<unknown>((resolve) => this.readers.push(resolve)));
  }

  async request(): Promise<RequestFrame> {
    const frame = parseInbound(await this.next());
    if (!("tool" in frame)) throw new Error(`Expected socket request, got ${JSON.stringify(frame)}`);
    return frame;
  }

  send(frame: object) { this.socket.write(encodeFrame(frame)); }
}

async function rawFixture(upstream?: string) {
  const path = join(await tempDir(), "raw.sock");
  const peers: RawPeer[] = [];
  const forwards: Socket[] = [];
  let accepted!: (peer: RawPeer) => void;
  const peer = new Promise<RawPeer>((resolve) => { accepted = resolve; });
  let upstreamAccepted!: (peer: RawPeer) => void;
  const replies = new Promise<RawPeer>((resolve) => { upstreamAccepted = resolve; });
  const server = createServer((socket) => {
    const connection = new RawPeer(socket);
    peers.push(connection);
    if (upstream) {
      const forward = createConnection(upstream);
      forwards.push(forward);
      upstreamAccepted(new RawPeer(forward));
      forward.on("error", (error) => socket.destroy(error));
      socket.pipe(forward).pipe(socket);
    }
    accepted(connection);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    for (const connection of peers) connection.socket.destroy();
    for (const forward of forwards) forward.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { path, peer, replies, token: "test-token-do-not-log" };
}

test("tools/list shows ask_lead, wait_lead, notify_lead without connecting to the socket", async () => {
  const client = await launch(join(await tempDir(), "missing.sock"), "list-only-token");
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual(["ask_lead", "notify_lead", "wait_lead"]);
  expect(tools.find((tool) => tool.name === "ask_lead")?.inputSchema.required).toEqual(["question"]);
});

test.each([{ choices: undefined }, { choices: ["yes", "no"] }])("ask_lead round trip returns a text answer with choices $choices", async ({ choices }) => {
  const f = await fixture();
  const client = await launch(f.path, f.token);
  const call = client.callTool({ name: "ask_lead", arguments: { question: "Continue?", choices } });
  const item = await nextItem(f.pending);
  expect(item).toMatchObject({ kind: "question", question: "Continue?", choices });
  f.pending.answer(item.requestId, { text: "a different answer" });
  expect(decoded(await within(call))).toEqual({ status: "answered", answer: { text: "a different answer" } });
});

test("wait_lead continues a pending question, consumes its reply once, and notify_lead delivers text", async () => {
  const f = await fixture(30);
  const client = await launch(f.path, f.token);
  const pending = decoded(await client.callTool({ name: "ask_lead", arguments: { question: "Later?" } }));
  expect(pending.status).toBe("pending");
  expect(typeof pending.questionId).toBe("string");
  expect(typeof pending.hint).toBe("string");
  f.pending.answer(pending.questionId, { text: "now" });
  expect(decoded(await client.callTool({ name: "wait_lead", arguments: { questionId: pending.questionId } })))
    .toEqual({ status: "answered", answer: { text: "now" } });
  expect(toolError(await client.callTool({ name: "wait_lead", arguments: { questionId: pending.questionId } }))).toContain("unknown");
  expect(decoded(await client.callTool({ name: "notify_lead", arguments: { text: "finished" } }))).toEqual({ ok: true });
  expect(f.notes).toEqual([["session-1", "finished"]]);
});

test("missing socket makes ask_lead return an MCP error naming the lead as unreachable", async () => {
  const client = await launch(join(await tempDir(), "missing.sock"), "missing-socket-token");
  expect(toolError(await within(client.callTool({ name: "ask_lead", arguments: { question: "Anyone?" } }))))
    .toMatch(/lead.*unreachable/i);
  expect((await client.listTools()).tools).toHaveLength(3);
});

test("client-side timeout sends a cancel frame for only that socket call", async () => {
  const f = await rawFixture();
  const client = await launch(f.path, f.token);
  const call = client.callTool({ name: "ask_lead", arguments: { question: "Wait?" } }, undefined, { timeout: 300 });
  const timedOut = call.then(() => { throw new Error("Expected MCP timeout"); }, (error: unknown) => error);
  const peer = await within(f.peer);
  expect(await peer.next()).toEqual({ hello: 1, token: f.token });
  const request = await peer.request();
  expect(request).toMatchObject({ tool: "ask_lead", args: { question: "Wait?" } });
  const other = client.callTool({ name: "wait_lead", arguments: { questionId: "other-question" } });
  const otherRequest = await peer.request();
  expect(await timedOut).toMatchObject({ code: ErrorCode.RequestTimeout });
  expect(await peer.next()).toEqual({ id: request.id, cancel: true });
  peer.send({ id: request.id, result: { status: "cancelled" } });
  peer.send({ id: otherRequest.id, result: { status: "answered", answer: { text: "still connected" } } });
  expect(decoded(await within(other))).toEqual({ status: "answered", answer: { text: "still connected" } });
});

test("MCP timeout reaches the real socket server before its 5000 ms bridge wait", async () => {
  const backend = await fixture(5000);
  const proxy = await rawFixture(backend.path);
  const client = await launch(proxy.path, backend.token);
  const call = client.callTool({ name: "ask_lead", arguments: { question: "Keep waiting?" } }, undefined, { timeout: 300 });
  const timedOut = call.then(() => { throw new Error("Expected MCP timeout"); }, (error: unknown) => error);
  const peer = await within(proxy.peer);
  expect(await peer.next()).toEqual({ hello: 1, token: backend.token });
  const request = await peer.request();
  const item = await nextItem(backend.pending);
  expect(await timedOut).toMatchObject({ code: ErrorCode.RequestTimeout });
  expect(await peer.next()).toEqual({ id: request.id, cancel: true });
  const replies = await within(proxy.replies);
  expect(await replies.next()).toEqual({ id: request.id, result: { status: "cancelled" } });
  expect(backend.pending.list("session-1").map((pending) => pending.requestId)).toEqual([item.requestId]);
  backend.pending.answer(item.requestId, { text: "answer after cancellation" });
  expect(decoded(await within(client.callTool({ name: "wait_lead", arguments: { questionId: item.requestId } }))))
    .toEqual({ status: "answered", answer: { text: "answer after cancellation" } });
});

test("server closing the socket mid-call returns an error instead of hanging", async () => {
  const f = await fixture();
  const client = await launch(f.path, f.token);
  const first = client.callTool({ name: "ask_lead", arguments: { question: "First?" } });
  await nextItem(f.pending);
  await f.server.close();
  expect(toolError(await within(first))).toMatch(/lead.*unreachable/i);
  expect((await client.listTools()).tools).toHaveLength(3);
});

test("cancelled session is forwarded as a cancelled result", async () => {
  const f = await fixture();
  const client = await launch(f.path, f.token);
  const call = client.callTool({ name: "ask_lead", arguments: { question: "Cancel session?" } });
  await nextItem(f.pending);
  f.pending.cancelSession("session-1");
  expect(decoded(await within(call))).toEqual({ status: "cancelled" });
});

test.each([
  { label: "wrong shape", payload: '{"id":"request-id"}\n' },
  { label: "wrong error type", payload: '{"id":"request-id","error":false}\n' },
  { label: "invalid JSON", payload: '{broken}\n' },
])("malformed socket reply ($label) is a tool error, after a valid reply positive control", async ({ payload }) => {
  const f = await rawFixture();
  const client = await launch(f.path, f.token);
  const control = client.callTool({ name: "notify_lead", arguments: { text: "positive control" } });
  const peer = await within(f.peer);
  expect(await peer.next()).toEqual({ hello: 1, token: f.token });
  const good = await peer.request();
  peer.send({ id: good.id, result: { ok: true } });
  expect(decoded(await within(control))).toEqual({ ok: true });
  const broken = client.callTool({ name: "ask_lead", arguments: { question: "Malformed?" } });
  const request = await peer.request();
  peer.socket.write(payload.replace("request-id", request.id));
  expect(toolError(await within(broken))).toMatch(/invalid.*reply|protocol/i);
});

test("stdin EOF closes an authenticated socket and exits cleanly without a kill", async () => {
  const f = await rawFixture();
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "lead-bridge", "--socket", f.path, "--token", f.token], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifetime-test", version: "1" },
  } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "notify_lead", arguments: { text: "alive until EOF" },
  } }) + "\n");
  const peer = await within(f.peer);
  expect(await peer.next()).toEqual({ hello: 1, token: f.token });
  const request = await peer.request();
  expect(request).toMatchObject({ tool: "notify_lead", args: { text: "alive until EOF" } });
  peer.send({ id: request.id, result: { ok: true } });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.split("\n").slice(0, -1).some((line) => line && JSON.parse(line).id === 2)) {
    const chunk = await within(reader.read());
    if (chunk.done) throw new Error("Process exited before tool reply");
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const reply = output.trim().split("\n").map((line) => JSON.parse(line)).find((frame) => frame.id === 2);
  expect(reply.result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  expect(child.exitCode).toBeNull();
  child.stdin.end();
  expect(await within(child.exited)).toBe(0);
  await within(peer.closed);
  expect(await stderr).not.toContain(f.token);
});

test("BridgeClient missing socket and disconnected calls reject with LeadUnreachable", async () => {
  const client = new BridgeClient();
  cleanups.push(async () => client.close());
  await expect(client.connect(join(await tempDir(), "missing.sock"), "token")).rejects.toBeInstanceOf(LeadUnreachable);
  await expect(client.call("notify_lead", { text: "disconnected" }, new AbortController().signal)).rejects.toBeInstanceOf(LeadUnreachable);
});

test.each(["disconnect", "close"])("BridgeClient %s rejects every outstanding call", async (action) => {
  const f = await rawFixture();
  const client = new BridgeClient();
  cleanups.push(async () => client.close());
  await client.connect(f.path, f.token);
  const peer = await within(f.peer);
  expect(await peer.next()).toEqual({ hello: 1, token: f.token });
  const first = client.call("ask_lead", { question: "First?" });
  const second = client.call("ask_lead", { question: "Second?" });
  const outcomes = Promise.allSettled([first, second]);
  const firstRequest = await peer.request();
  const secondRequest = await peer.request();
  expect(firstRequest.id).not.toBe(secondRequest.id);
  if (action === "disconnect") peer.socket.destroy();
  else client.close();
  const results = await within(outcomes);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(LeadUnreachable);
  }
});

test("BridgeClient handles split UTF-8 and coalesced out-of-order replies", async () => {
  const f = await rawFixture();
  const client = new BridgeClient();
  cleanups.push(async () => client.close());
  await client.connect(f.path, f.token);
  const peer = await within(f.peer);
  await peer.next();
  const first = client.call("ask_lead", { question: "First?" });
  const second = client.call("notify_lead", { text: "Second" });
  const a = await peer.request();
  const b = await peer.request();
  const payload = Buffer.concat([
    encodeFrame({ id: b.id, result: { ok: true } }),
    encodeFrame({ id: a.id, result: { status: "answered", answer: { text: "żółw" } } }),
  ]);
  const split = payload.indexOf(Buffer.from("ż")) + 1;
  peer.socket.write(payload.subarray(0, split));
  peer.socket.write(payload.subarray(split));
  expect(await within(first)).toEqual({ status: "answered", answer: { text: "żółw" } });
  expect(await within(second)).toEqual({ ok: true });
});

test("BridgeClient pre-aborted signal sends no request and leaves later calls usable", async () => {
  const f = await rawFixture();
  const client = new BridgeClient();
  cleanups.push(async () => client.close());
  await client.connect(f.path, f.token);
  const peer = await within(f.peer);
  await peer.next();
  const controller = new AbortController();
  controller.abort();
  await expect(client.call("ask_lead", { question: "Must not send" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  const call = client.call("notify_lead", { text: "still usable" });
  const request = await peer.request();
  expect(request).toMatchObject({ tool: "notify_lead", args: { text: "still usable" } });
  peer.send({ id: request.id, result: { ok: true } });
  expect(await within(call)).toEqual({ ok: true });
});

test.each([[], ["--socket", "/tmp/test.sock"], ["--socket", "/tmp/test.sock", "--token", "secret", "--other"]].map((args) => ({ args })))(
  "invalid lead-bridge arguments fail on stderr without stdout or token disclosure: $args", async ({ args }) => {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "lead-bridge", ...args], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(await within(child.exited)).toBe(2);
    expect(await new Response(child.stdout).text()).toBe("");
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("usage:");
    expect(stderr).not.toContain("secret");
  },
);
