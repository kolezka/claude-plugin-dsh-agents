import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { ConfigError } from "../src/config";
import { PendingQueue, type PendingItem } from "../src/bridge/pending";
import { BridgeSocketServer } from "../src/bridge/socket";

class Peer {
  readonly closed: Promise<void>;
  private frames: any[] = [];
  private readers: Array<(frame: any) => void> = [];
  private buffer = "";

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        const reader = this.readers.shift();
        if (reader) reader(frame);
        else this.frames.push(frame);
      }
    });
  }

  send(frame: object) { this.socket.write(JSON.stringify(frame) + "\n"); }

  next(): Promise<any> {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No decoded reply within 1 second")), 1000);
      this.readers.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }
}

const roots: string[] = [];
const servers: BridgeSocketServer[] = [];
const peers: Peer[] = [];
const rawServers: Server[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.socket.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const server of rawServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(bridgeWaitMs = 30) {
  const root = await mkdtemp("/tmp/dsh-bridge-");
  roots.push(root);
  const socketDir = join(root, "private");
  const pending = new PendingQueue();
  const notes: Array<[string, string]> = [];
  const logs: string[] = [];
  const server = new BridgeSocketServer({
    socketDir, pending, bridgeWaitMs,
    onNote: (session, text) => notes.push([session, text]),
    log: (line) => logs.push(line),
  });
  servers.push(server);
  return { root, socketDir, pending, server, notes, logs };
}

async function connect(path: string, token?: string) {
  const peer = new Peer(createConnection(path));
  peers.push(peer);
  await new Promise<void>((resolve, reject) => {
    peer.socket.once("connect", resolve);
    peer.socket.once("error", reject);
  });
  if (token !== undefined) peer.send({ hello: 1, token });
  return peer;
}

async function authenticated(f: Awaited<ReturnType<typeof fixture>>, session = "s1") {
  const token = f.server.allocateToken();
  f.server.bindToken(token, session);
  return connect(await f.server.listen(), token);
}

function nextItem(pending: PendingQueue, session = "s1"): Promise<PendingItem> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("No pending item")); }, 1000);
    const check = () => {
      const item = pending.list(session)[0];
      if (item) { clearTimeout(timer); unsubscribe(); resolve(item); }
    };
    const unsubscribe = pending.onChange(check);
    check();
  });
}

function request(peer: Peer, id: string, tool: string, args: object) {
  peer.send({ id, tool, args });
  return peer.next();
}

test("hello with an unknown token closes the connection without logging token values", async () => {
  const f = await fixture();
  const peer = await connect(await f.server.listen(), "never-log-this-token");
  await peer.closed;
  expect(f.logs.join("\n")).toMatch(/token|auth/i);
  expect(f.logs.join("\n")).not.toContain("never-log-this-token");
});

test.each([null, [], { id: "bad" }, { id: "bad", tool: "ask_lead", args: [] }].map((shape) => ({ shape })))(
  "valid JSON with wrong shape %j closes only the offending connection with a reason",
  async ({ shape }) => {
    const f = await fixture();
    const healthy = await authenticated(f);
    const bad = await connect(await f.server.listen());
    bad.socket.write(JSON.stringify(shape) + "\n");
    await bad.closed;
    expect(f.logs.join("\n")).toMatch(/shape|frame/i);
    expect(await request(healthy, "note", "notify_lead", { text: "still alive" }))
      .toEqual({ id: "note", result: { ok: true } });
    expect(f.notes).toEqual([["s1", "still alive"]]);
  },
);

test("unauthenticated calls, repeated hello, malformed JSON and oversize frames close", async () => {
  const f = await fixture();
  const healthy = await authenticated(f);
  const token = f.server.allocateToken();
  f.server.bindToken(token, "s1");
  for (const payload of [
    '{"id":"x","tool":"notify_lead","args":{"text":"no"}}\n',
    '{oops}\n',
    "a".repeat(1_048_577),
    JSON.stringify({ hello: 1, token }) + "\n" + JSON.stringify({ hello: 1, token }) + "\n",
  ]) {
    const bad = await connect(await f.server.listen());
    bad.socket.write(payload);
    await bad.closed;
  }
  expect(f.notes).toEqual([]);
  expect(await request(healthy, "ok", "notify_lead", { text: "yes" }))
    .toEqual({ id: "ok", result: { ok: true } });
  expect(f.logs.join("\n")).not.toContain(token);
});

test("socket accepts split UTF-8 and coalesced frames", async () => {
  const f = await fixture();
  const peer = await authenticated(f);
  const payload = Buffer.from('{"id":"a","tool":"notify_lead","args":{"text":"ż🙂"}}\n');
  const split = payload.indexOf(Buffer.from("🙂")) + 1;
  peer.socket.write(payload.subarray(0, split));
  peer.socket.write(Buffer.concat([
    payload.subarray(split),
    Buffer.from('{"id":"b","tool":"notify_lead","args":{"text":"second"}}\n'),
  ]));
  expect(await peer.next()).toEqual({ id: "a", result: { ok: true } });
  expect(await peer.next()).toEqual({ id: "b", result: { ok: true } });
  expect(f.notes).toEqual([["s1", "ż🙂"], ["s1", "second"]]);
});

test("ask_lead returns pending after bridgeWaitMs and wait_lead gets the answer once", async () => {
  const f = await fixture();
  const peer = await authenticated(f);
  const reply = await request(peer, "ask", "ask_lead", { question: "Continue?" });
  expect(reply.id).toBe("ask");
  expect(reply.result.status).toBe("pending");
  expect(typeof reply.result.questionId).toBe("string");
  expect(typeof reply.result.hint).toBe("string");
  const id = reply.result.questionId;
  expect(f.pending.list("s1").map((item) => item.requestId)).toContain(id);
  f.pending.answer(id, { text: "yes" });
  expect(await request(peer, "wait", "wait_lead", { questionId: id }))
    .toEqual({ id: "wait", result: { status: "answered", answer: { text: "yes" } } });
  expect(await request(peer, "again", "wait_lead", { questionId: id }))
    .toEqual({ id: "again", error: "unknown" });
});

test.each([
  { label: "without choices", choices: undefined, text: "pineapple" },
  { label: "matching proposed choices", choices: ["pineapple", "pear"], text: "pineapple" },
  { label: "outside proposed choices", choices: ["pineapple", "pear"], text: "plum instead" },
])("ask_lead returns a decoded text answer $label", async ({ choices, text }) => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  peer.send({ id: "ask", tool: "ask_lead", args: { question: "Which fruit?", choices } });
  const item = await nextItem(f.pending);
  expect(item.kind).toBe("question");
  if (item.kind !== "question") throw new Error("ask_lead did not create a question");
  expect<readonly string[] | undefined>(item.choices).toEqual(choices);
  f.pending.answer(item.requestId, { text });
  expect(await peer.next()).toEqual({ id: "ask", result: { status: "answered", answer: { text } } });
  expect(f.pending.list("s1")).toEqual([]);
});

test("cancel frame aborts the wait but keeps the question pending", async () => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  const waiting = request(peer, "ask", "ask_lead", { question: "Keep?" });
  const item = await nextItem(f.pending);
  peer.send({ id: "ask", cancel: true });
  expect(await waiting).toEqual({ id: "ask", result: { status: "cancelled" } });
  expect(f.pending.list("s1")).toEqual([item]);
  f.pending.answer(item.requestId, { text: "later" });
  expect(await request(peer, "later", "wait_lead", { questionId: item.requestId }))
    .toEqual({ id: "later", result: { status: "answered", answer: { text: "later" } } });
});

test("wait_lead timeout and cancellation keep the same question without creating another", async () => {
  const f = await fixture();
  const peer = await authenticated(f);
  const ask = await request(peer, "ask", "ask_lead", { question: "Still waiting?" });
  const questionId = ask.result.questionId;
  const timedOut = await request(peer, "wait-timeout", "wait_lead", { questionId });
  expect(timedOut.result.status).toBe("pending");
  expect(timedOut.result.questionId).toBe(questionId);
  const waiting = request(peer, "wait-cancel", "wait_lead", { questionId });
  peer.send({ id: "wait-cancel", cancel: true });
  expect(await waiting).toEqual({ id: "wait-cancel", result: { status: "cancelled" } });
  expect(f.pending.list("s1").map((item) => item.requestId)).toEqual([questionId]);
  f.pending.answer(questionId, { text: "finally" });
  expect(await request(peer, "wait-final", "wait_lead", { questionId }))
    .toEqual({ id: "wait-final", result: { status: "answered", answer: { text: "finally" } } });
});

test("two sessions interleave without cross-talk or stolen buffered answers", async () => {
  const f = await fixture();
  const first = await authenticated(f, "s1");
  const second = await authenticated(f, "s2");
  const [a, b] = await Promise.all([
    request(first, "same-id", "ask_lead", { question: "First?" }),
    request(second, "same-id", "ask_lead", { question: "Second?" }),
  ]);
  expect(a.result.status).toBe("pending");
  expect(b.result.status).toBe("pending");
  const idA = a.result.questionId;
  const idB = b.result.questionId;
  expect(await request(second, "steal", "wait_lead", { questionId: idA }))
    .toEqual({ id: "steal", error: "unknown" });
  f.pending.answer(idA, { text: "only first" });
  f.pending.answer(idB, { text: "only second" });
  expect(await request(second, "steal-buffered", "wait_lead", { questionId: idA }))
    .toEqual({ id: "steal-buffered", error: "unknown" });
  expect(await request(second, "own", "wait_lead", { questionId: idB }))
    .toEqual({ id: "own", result: { status: "answered", answer: { text: "only second" } } });
  expect(await request(first, "own", "wait_lead", { questionId: idA }))
    .toEqual({ id: "own", result: { status: "answered", answer: { text: "only first" } } });
});

test("wait_lead cannot consume permission items even in its own session", async () => {
  const f = await fixture();
  const peer = await authenticated(f);
  const permission = f.pending.addPermission("s1", "call", [
    { optionId: "allow", kind: "allow_once", name: "Allow" },
  ], "missing");
  f.pending.answer(permission.requestId, { choice: "allow" });
  expect(await request(peer, "steal", "wait_lead", { questionId: permission.requestId }))
    .toEqual({ id: "steal", error: "unknown" });
  expect(await f.pending.waitFor(permission.requestId, 100)).toEqual({ choice: "allow" });
});

test("disconnect drops open waits; the question survives for a new connection", async () => {
  const f = await fixture(1000);
  const first = await authenticated(f);
  first.send({ id: "ask", tool: "ask_lead", args: { question: "Survive?" } });
  const item = await nextItem(f.pending);
  first.socket.destroy();
  await first.closed;
  const second = await authenticated(f);
  f.pending.answer(item.requestId, { text: "after disconnect" });
  expect(await request(second, "resume", "wait_lead", { questionId: item.requestId }))
    .toEqual({ id: "resume", result: { status: "answered", answer: { text: "after disconnect" } } });
});

test("duplicate request id is rejected both while open and after completion", async () => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  peer.send({ id: "same", tool: "ask_lead", args: { question: "Only one?" } });
  await nextItem(f.pending);
  expect(await request(peer, "same", "ask_lead", { question: "Duplicate?" }))
    .toMatchObject({ id: "same", error: expect.stringMatching(/duplicate/i) });
  expect(f.pending.list("s1")).toHaveLength(1);
  peer.send({ id: "same", cancel: true });
  expect(await peer.next()).toEqual({ id: "same", result: { status: "cancelled" } });
  expect(await request(peer, "same", "notify_lead", { text: "No" }))
    .toMatchObject({ id: "same", error: expect.stringMatching(/duplicate/i) });
  expect(f.notes).toEqual([]);
});

test("cancelSession resolves ask_lead with status cancelled", async () => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  const waiting = request(peer, "ask", "ask_lead", { question: "Cancel?" });
  await nextItem(f.pending);
  f.pending.cancelSession("s1");
  expect(await waiting).toEqual({ id: "ask", result: { status: "cancelled" } });
});

test("resume invalidation terminates socket waits with an unknown error", async () => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  const waiting = request(peer, "ask", "ask_lead", { question: "Stale?" });
  await nextItem(f.pending);
  f.pending.invalidateSession("s1");
  expect(await waiting).toEqual({ id: "ask", error: "unknown" });
});

test("allocated token accepts hello before binding but tools cannot run until bound", async () => {
  const f = await fixture();
  const path = await f.server.listen();
  const token = f.server.allocateToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(f.server.allocateToken()).not.toBe(token);
  const peer = await connect(path, token);
  expect(await request(peer, "early", "notify_lead", { text: "No session yet" }))
    .toMatchObject({ id: "early", error: expect.stringMatching(/bound/i) });
  expect(f.notes).toEqual([]);
  f.server.bindToken(token, "s1");
  f.server.bindToken(token, "s1");
  expect(() => f.server.bindToken(token, "s2")).toThrow();
  expect(() => f.server.bindToken("unknown-secret", "s1")).toThrow();
  expect(await request(peer, "ready", "notify_lead", { text: "Bound" }))
    .toEqual({ id: "ready", result: { ok: true } });
  expect(f.notes).toEqual([["s1", "Bound"]]);
  expect(f.logs.join("\n")).not.toContain(token);
});

test("releaseSession revokes all its tokens and connections without harming another session", async () => {
  const f = await fixture(1000);
  const first = await authenticated(f, "s1");
  const token = f.server.allocateToken();
  f.server.bindToken(token, "s1");
  const same = await connect(await f.server.listen(), token);
  const other = await authenticated(f, "s2");
  first.send({ id: "ask", tool: "ask_lead", args: { question: "Release?" } });
  await nextItem(f.pending);
  f.server.releaseSession("s1");
  await Promise.all([first.closed, same.closed]);
  expect(() => f.server.bindToken(token, "s2")).toThrow();
  const revoked = await connect(await f.server.listen(), token);
  await revoked.closed;
  expect(await request(other, "note", "notify_lead", { text: "Alive" }))
    .toEqual({ id: "note", result: { ok: true } });
});

test("invalid tool arguments return errors without adding questions or notes", async () => {
  const f = await fixture();
  const peer = await authenticated(f);
  for (const [id, tool, args] of [
    ["a", "ask_lead", {}], ["b", "ask_lead", { question: 1 }],
    ["c", "ask_lead", { question: "?", choices: [1] }],
    ["d", "wait_lead", {}], ["e", "notify_lead", { text: 1 }],
  ] as const) {
    expect(await request(peer, id, tool, args)).toMatchObject({ id, error: expect.any(String) });
  }
  expect(f.pending.list("s1")).toEqual([]);
  expect(f.notes).toEqual([]);
});

test("disconnect after answer consumption does not replay an unacknowledged reply", async () => {
  const f = await fixture(1000);
  const peer = await authenticated(f);
  peer.socket.pause();
  peer.send({ id: "ask", tool: "ask_lead", args: { question: "Consume once?" } });
  const item = await nextItem(f.pending);
  f.pending.answer(item.requestId, { text: "consumed" });
  await expect(f.pending.waitFor(item.requestId, 100)).rejects.toThrow("unknown");
  peer.socket.destroy();
  await peer.closed;
  const second = await authenticated(f);
  expect(await request(second, "retry", "wait_lead", { questionId: item.requestId }))
    .toEqual({ id: "retry", error: "unknown" });
});

test("socket directory is 0700 and socket is 0600, including an existing loose directory", async () => {
  for (const existing of [false, true]) {
    const f = await fixture();
    if (existing) { await mkdir(f.socketDir); await chmod(f.socketDir, 0o755); }
    const path = await f.server.listen();
    expect((await lstat(f.socketDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await f.server.close();
    await expect(lstat(path)).rejects.toThrow();
  }
});

test("stale socket file is probed and unlinked before listen", async () => {
  const f = await fixture();
  await mkdir(f.socketDir);
  const path = join(f.socketDir, `s-${process.pid}.sock`);
  const child = Bun.spawn([process.execPath, "-e", `
    import { createServer } from "node:net";
    createServer().listen(process.env.TEST_SOCKET, () => process.stdout.write("ready\\n"));
  `], { env: { ...process.env, TEST_SOCKET: path }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    expect((await lstat(path)).isSocket()).toBe(true);
    expect(await f.server.listen()).toBe(path);
    const peer = await authenticated(f);
    expect(await request(peer, "note", "notify_lead", { text: "Replacement works" }))
      .toEqual({ id: "note", result: { ok: true } });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("an active socket is never unlinked or taken over", async () => {
  const f = await fixture();
  await mkdir(f.socketDir);
  const path = join(f.socketDir, `s-${process.pid}.sock`);
  const active = createServer((socket) => socket.end("active\n"));
  rawServers.push(active);
  await new Promise<void>((resolve) => active.listen(path, resolve));
  const inode = (await lstat(path)).ino;
  await expect(f.server.listen()).rejects.toThrow();
  expect((await lstat(path)).ino).toBe(inode);
  const peer = await connect(path);
  // Use a non-JSON positive control separately from the bridge peer decoder.
  peer.socket.removeAllListeners("data");
  const text = await new Promise<string>((resolve) => peer.socket.once("data", resolve));
  expect(text).toBe("active\n");
  await f.server.close();
  expect((await lstat(path)).ino).toBe(inode);
});

test("existing non-socket files are preserved", async () => {
  const f = await fixture();
  await mkdir(f.socketDir);
  const path = join(f.socketDir, `s-${process.pid}.sock`);
  await Bun.write(path, "do not remove");
  await expect(f.server.listen()).rejects.toThrow();
  expect(await Bun.file(path).text()).toBe("do not remove");
});

test("socket path limit is checked in bytes and rejects 104 bytes", async () => {
  const f = await fixture();
  const nameBytes = Buffer.byteLength(`/s-${process.pid}.sock`);
  for (const dir of ["/" + "a".repeat(103 - nameBytes), "/" + "ż".repeat(52)]) {
    const server = new BridgeSocketServer({ socketDir: dir, pending: f.pending, bridgeWaitMs: 30, onNote() {}, log() {} });
    servers.push(server);
    await expect(server.listen()).rejects.toBeInstanceOf(ConfigError);
  }
});
