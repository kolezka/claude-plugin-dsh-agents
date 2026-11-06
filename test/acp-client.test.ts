import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";
import { Journal, JournalReadError } from "../src/journal";
import { PendingQueue } from "../src/bridge/pending";
import { BridgeSocketServer } from "../src/bridge/socket";
import { loadConfig } from "../src/config";
import type { Script } from "./fake-acp-agent";
import type { LifecycleScript } from "./fake-acp-lifecycle-agent";
import { createConnection, type Socket } from "node:net";
import type { StopReason } from "@agentclientprotocol/sdk";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function executable(script: LifecycleScript, timeout = 60_000, agent = "fake-acp-agent.ts") {
  const dir = await mkdtemp("/tmp/dsha6-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "script.json");
  await Bun.write(path, JSON.stringify(script));
  const bin = join(dir, "fake-dsh");
  await Bun.write(bin, `#!/bin/sh\nexport FAKE_ACP_SCRIPT='${path}'\nexport FAKE_ACP_TOOL_TIMEOUT_MS='${timeout}'\nexec '${process.execPath}' '${resolve(import.meta.dir, agent)}' "$@"\n`);
  await chmod(bin, 0o700);
  const trace = async (): Promise<Array<{ method: string; params: any }>> => {
    if (!await Bun.file(`${path}.trace`).exists()) return [];
    return (await Bun.file(`${path}.trace`).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  return { dir, path, bin, trace };
}
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await Bun.sleep(10); }
  throw new Error("fixture condition deadline exceeded");
}

test("fake executable initialize positive control", async () => {
  const f = await executable({});
  const proc = Bun.spawn([f.bin, "--profile", "acp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { proc.kill(); await proc.exited; });
  const connection = new ClientApp().connect(ndJsonStream(new WritableStream({ write: bytes => { proc.stdin.write(bytes); proc.stdin.flush(); }, close: () => { proc.stdin.end(); } }), proc.stdout));
  const initialized = await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  expect(initialized.agentInfo?.name).toBe("fake-dsh");
  expect((await f.trace()).map(t => t.method)).toEqual(["initialize"]);
  proc.stdin.end(); await proc.exited;
});

async function fixture(script: LifecycleScript = {}, overrides: { agent?: string; transportEnded?: () => void; wire?: (message: any) => Promise<void>; permissions?: "ask" | "allow"; bridgeWaitMs?: number; timeout?: number; now?: () => number; holdPrompt?: { gate: Promise<void>; entered: () => void; wire: string[] } } = {}) {
  const f = await executable(script, overrides.timeout, overrides.agent);
  const { DshChild } = await import("../src/acp/child");
  const api = await import("../src/acp/client");
  const cfg = loadConfig({ DSH_HOME: f.dir, DSH_AGENTS_DSH_BIN: f.bin, TMPDIR: f.dir }, () => false);
  cfg.permissions = overrides.permissions ?? "ask";
  const journal = new Journal(join(cfg.stateDir, "sessions"));
  const pending = new PendingQueue();
  const logs: string[] = [];
  const bridge = new BridgeSocketServer({ socketDir: cfg.socketDir, pending, bridgeWaitMs: overrides.bridgeWaitMs ?? 45_000, onNote: (session, text) => { void journal.append(session, { t: "note", text, at: Date.now() }); }, log: line => logs.push(line) });
  const children: InstanceType<typeof DshChild>[] = [];
  const createClient = () => {
    const client = new api.DshAcpClient({ cfg, journal, pending, bridge, now: overrides.now, spawnChild: () => {
      const child = new DshChild(cfg, line => logs.push(line));
      if (overrides.transportEnded) {
        const start = child.start.bind(child);
        child.start = async () => {
          const { stream } = await start();
          return { stream: { ...stream, readable: stream.readable.pipeThrough(new TransformStream({
            transform: (message, controller) => controller.enqueue(message),
            // Observe upstream EOF, not a child trace that cleanup can interrupt.
            flush: () => { overrides.transportEnded!(); },
          })) } };
        };
      }
      if (overrides.wire) {
        const start = child.start.bind(child);
        child.start = async () => {
          const { stream } = await start();
          const writer = stream.writable.getWriter();
          return { stream: { ...stream, writable: new WritableStream({
            write: async message => { await overrides.wire!(message); await writer.write(message); },
            close: () => writer.close(), abort: reason => writer.abort(reason),
          }) } };
        };
      }
      if (overrides.holdPrompt) {
        const control = overrides.holdPrompt;
        const start = child.start.bind(child);
        child.start = async () => {
          const { stream } = await start();
          const writer = stream.writable.getWriter();
          return { stream: { ...stream, writable: new WritableStream({
            write: async message => {
              if ("method" in message && message.method === "session/prompt") { control.entered(); await control.gate; }
              await writer.write(message);
              if ("method" in message) control.wire.push(message.method);
            }, close: () => writer.close(), abort: reason => writer.abort(reason),
          }) } };
        };
      }
      children.push(child); return child;
    } });
    cleanups.push(() => client.shutdown());
    return client;
  };
  cleanups.push(() => bridge.close());
  cleanups.push(async () => { for (const child of children) await child.shutdown(); });
  const client = createClient();
  const release = async (name: string) => { await Bun.write(`${f.path}.release-${encodeURIComponent(name)}`, "release"); };
  cleanups.push(async () => {
    for (const name of [...script.gates ?? [], ...script.closeGate ? [script.closeGate] : [], ...script.prompts?.flatMap(p => [p.questionGate, p.permissionGate].filter((name): name is string => name !== undefined)) ?? []]) await release(name);
  });
  const terminal = (run: { session: string; runId: string }) => until(async () => {
    const result = await client.follow({ ...run, after: 0, waitSeconds: 0 });
    return ["final", "cancelled", "error", "unknown"].includes(result.status) && result;
  });
  const question = (session: string) => until(async () => pending.list(session).find(p => p.kind === "question"));
  const permission = (session: string) => until(async () => pending.list(session).find(p => p.kind === "permission"));
  return { ...f, cfg, journal, pending, logs, bridge, children, client, createClient, terminal, question, permission, api, release };
}

test("start returns submitted before the prompt settles; follow reaches final with the reply", async () => {
  const f = await fixture({ prompts: [{ delay: 150 }] });
  expect(f.children).toHaveLength(0);
  const run = await f.client.start({ task: "exact task" });
  expect(run.status).toBe("submitted");
  expect((await f.client.follow({ ...run, after: 0, waitSeconds: 0 })).status).not.toBe("final");
  const result = await f.terminal(run);
  expect(result.reply).toBe("fixture reply"); expect(result.status).toBe("final");
  const cursor = result.next;
  expect((await f.client.follow({ ...run, after: cursor, waitSeconds: 0 })).events).toEqual([]);
  const fresh = f.createClient();
  expect((await fresh.follow({ ...run, after: cursor, waitSeconds: 0 })).reply).toBe("fixture reply");
  const records = (await f.journal.read(run.session, 0)).records;
  expect(records[0]?.t).toBe("submitted");
  expect(records.at(-1)?.t).toBe("settled");
});

test("start with model calls set_config_option first and fails with ModelNotAvailable on an unknown value", async () => {
  const f = await fixture();
  const run = await f.client.start({ task: "model task", model: "fixture/alternate", reasoningEffort: "high" });
  await f.terminal(run);
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/set_config_option").map(t => [t.params.configId, t.params.value])).toEqual([["model", "fixture/alternate"], ["reasoning_effort", "high"]]);
  expect(trace.findIndex(t => t.method === "session/set_config_option")).toBeLessThan(trace.findIndex(t => t.method === "session/prompt"));
  await expect(f.client.start({ session: run.session, task: "bad model", model: "not-advertised" })).rejects.toBeInstanceOf(f.api.ModelNotAvailable);
  expect((await f.trace()).filter(t => t.method === "session/prompt")).toHaveLength(1);
});

test("configuration must confirm currentValue before prompting", async () => {
  const f = await fixture({ ignoreConfig: true });
  await expect(f.client.start({ task: "must not prompt", model: "fixture/alternate" })).rejects.toBeInstanceOf(f.api.ModelNotAvailable);
  expect((await f.trace()).some(t => t.method === "session/prompt")).toBe(false);
});

test("permission request becomes a pending item joined with its tool_call; answer allow-once lets the run finish", async () => {
  const f = await fixture({ prompts: [{ permission: "after" }] });
  const run = await f.client.start({ task: "permission task" });
  const p = await f.permission(run.session);
  expect(p.toolCallId).toBe("tool-exact-1"); expect(p.context).toEqual({ title: "Read fixture", kind: "read", rawInput: { path: "fixture.txt" } });
  await f.client.answer({ session: run.session, requestId: p.requestId, choice: "allow-once" });
  expect((await f.terminal(run)).status).toBe("final");
  expect((await f.trace()).find(t => t.method === "permission-result")?.params).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
});

for (const permission of ["missing", "before"] as const) test(`permission request without a tool_call update is pending with context missing (${permission})`, async () => {
  const f = await fixture({ prompts: [{ permission }] });
  const run = await f.client.start({ task: "missing context" });
  const p = await f.permission(run.session); expect(p.context).toBe("missing");
  await f.client.answer({ session: run.session, requestId: p.requestId, choice: "allow-once" }); await f.terminal(run);
});

test("ask_lead from the fake agent appears as a pending question; answer reaches the agent as the tool result", async () => {
  const f = await fixture({ prompts: [{ question: "Which exact fruit?", choices: ["pear", "apple"] }] });
  const run = await f.client.start({ task: "lead question" });
  const q = await f.question(run.session); expect(q.question).toBe("Which exact fruit?");
  const before = await f.client.follow({ ...run, after: 0, waitSeconds: 0 }); expect(before.status).toBe("waiting");
  const follow = f.client.follow({ ...run, after: before.next, waitSeconds: 2 });
  await f.client.answer({ session: run.session, requestId: q.requestId, text: "pineapple" });
  expect((await follow).pending.map(p => p.requestId)).toContain(q.requestId);
  expect((await f.terminal(run)).reply).toContain('"text":"pineapple"');
  const history = await f.journal.history(run.session);
  expect(history.find(h => h.role === "lead")?.text).toBe("pineapple");
  const records = (await f.journal.read(run.session, 0)).records;
  expect(records.filter(r => r.t === "question")).toEqual([expect.objectContaining({ requestId: q.requestId, runId: run.runId, question: q.question })]);
});

test("fake agent with a 300 ms tool timeout still gets the answer through wait_lead polling", async () => {
  const f = await fixture({ prompts: [{ question: "accelerated exact question" }] }, { timeout: 300, bridgeWaitMs: 100 });
  const run = await f.client.start({ task: "poll task" });
  const q = await f.question(run.session);
  await until(async () => (await f.trace()).find(t => t.method === "wait-result" && t.params.status === "pending" && t.params.questionId === q.requestId));
  await f.client.answer({ session: run.session, requestId: q.requestId, text: "poll answer" });
  expect((await f.terminal(run)).reply).toContain("poll answer");
  expect((await f.trace()).find(t => t.method === "ask-result")?.params.questionId).toBe(q.requestId);
});

test("second start while a prompt is in flight throws PromptInFlight with waiting=true when a question is open", async () => {
  const f = await fixture({ prompts: [{ question: "busy question" }] });
  const run = await f.client.start({ task: "first" }); await f.question(run.session);
  try { await f.client.start({ session: run.session, task: "second" }); throw new Error("accepted duplicate"); }
  catch (error) { expect(error).toBeInstanceOf(f.api.PromptInFlight); expect(error).toMatchObject({ runId: run.runId, waiting: true }); }
});

test("cancel resolves pending items first, then the run settles cancelled", async () => {
  const f = await fixture({ prompts: [{ permission: "after", cancelDelay: 150 }] });
  const run = await f.client.start({ task: "cancel permission" }); await f.permission(run.session);
  await f.client.cancel(run.session); expect(f.pending.list(run.session)).toEqual([]);
  await expect(f.client.start({ session: run.session, task: "too soon" })).rejects.toBeInstanceOf(f.api.PromptInFlight);
  expect((await f.terminal(run)).status).toBe("cancelled");
  const trace = await f.trace();
  expect(trace.find(t => t.method === "permission-result")?.params.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  expect(trace.findIndex(t => t.method === "permission-result")).toBeLessThan(trace.findIndex(t => t.method === "session/cancel"));
});

test("child exit mid-prompt gives status unknown and the journal keeps the submitted record", async () => {
  const f = await fixture({ prompts: [{ exit: true }] });
  const run = await f.client.start({ task: "crash task" });
  expect((await f.terminal(run)).status).toBe("unknown");
  expect((await f.journal.read(run.session, 0)).records[0]).toMatchObject({ t: "submitted", runId: run.runId, task: "crash task" });
  expect((await f.trace()).filter(t => t.method === "session/prompt")).toHaveLength(1);
  const next = await f.client.start({ session: run.session, task: "explicit new task" });
  expect(next.runId).not.toBe(run.runId); expect(f.children).toHaveLength(2);
});

test("resume after a client restart declares a new token and invalidates old pending items", async () => {
  const f = await fixture({ prompts: [{ question: "old question" }] });
  const old = await f.client.start({ task: "before restart" }); const q = await f.question(old.session);
  await f.children[0]!.shutdown();
  const second = f.createClient();
  const orphan = await second.follow({ ...old, after: 0, waitSeconds: 0 }); expect(orphan.status).toBe("unknown");
  const run = await second.start({ session: old.session, task: "after restart" });
  expect(run.session).toBe(old.session);
  await expect(second.answer({ session: old.session, requestId: q.requestId, text: "stale" })).rejects.toBeInstanceOf(f.api.UnknownRequest);
  const third = f.createClient();
  await expect(third.follow({ ...old, after: 0, waitSeconds: 0 })).rejects.toBeInstanceOf(f.api.UnknownRequest);
  const trace = await f.trace();
  const declarations = trace.filter(t => ["session/new", "session/resume"].includes(t.method)).map(t => t.params.mcpServers[0]);
  expect(declarations).toHaveLength(2); expect(declarations[0].args.at(-1)).not.toBe(declarations[1].args.at(-1));
  expect(declarations[1].command).toBe(process.execPath); expect(declarations[1].args[0]).toBe(resolve(import.meta.dir, "../src/cli.ts"));
  expect(declarations[1].env).toEqual([]);
});

test("start with a cwd different from the persisted one throws CwdMismatch with the agent's text", async () => {
  const f = await fixture({ sessions: [{ sessionId: "persisted", cwd: "/persisted/cwd" }] });
  await expect(f.client.start({ session: "persisted", cwd: "/wrong/cwd", task: "wrong cwd" })).rejects.toMatchObject({ name: "CwdMismatch", message: expect.stringContaining("session cwd does not match") });
  expect((await f.trace()).some(t => t.method === "session/new")).toBe(false);
});

test("answer on a settled run throws UnknownRequest", async () => {
  const f = await fixture({ prompts: [{ permission: "after" }] });
  const run = await f.client.start({ task: "answer only once" }); const p = await f.permission(run.session);
  await f.client.answer({ session: run.session, requestId: p.requestId, choice: "allow-once" }); await f.terminal(run);
  await expect(f.client.answer({ session: run.session, requestId: p.requestId, choice: "allow-once" })).rejects.toBeInstanceOf(f.api.UnknownRequest);
});

test("a non-JSON line on the child's stdout is logged and the connection keeps working", async () => {
  const f = await fixture({ stray: true });
  const run = await f.client.start({ task: "stray stdout" }); expect((await f.terminal(run)).reply).toBe("fixture reply");
  expect(f.logs.filter(l => l.includes("non-object"))).toHaveLength(3);
});

test("permissions allow auto-answers by kind and journals auto: true", async () => {
  const f = await fixture({ prompts: [{ permission: "after" }] }, { permissions: "allow" });
  const run = await f.client.start({ task: "auto permission" }); await f.terminal(run);
  expect(f.pending.list(run.session)).toEqual([]);
  expect((await f.journal.read(run.session, 0)).records.find(r => r.t === "permission")).toMatchObject({ auto: true, toolCallId: "tool-exact-1" });
  expect((await f.trace()).find(t => t.method === "permission-result")?.params.outcome.optionId).toBe("allow-once");
});

test("sessions merges session/list with liveHere", async () => {
  const f = await fixture({ sessions: [{ sessionId: "older", cwd: "/a", title: "Older", updatedAt: "2020-01-01T00:00:00Z" }, { sessionId: "newer", cwd: "/b", title: "Newer", updatedAt: "2025-01-01T00:00:00Z" }] });
  const run = await f.client.start({ task: "local", cwd: "/local" }); await f.terminal(run);
  const sessions = await f.client.sessions({});
  expect(sessions.map(s => s.session)).toContain("older"); expect(sessions.map(s => s.session)).toContain("newer");
  expect(sessions.find(s => s.session === run.session)?.liveHere).toBe(true);
  expect(sessions.find(s => s.session === "older")).toMatchObject({ cwd: "/a", liveHere: false, title: "Older" });
  expect(sessions.findIndex(s => s.session === "newer")).toBeLessThan(sessions.findIndex(s => s.session === "older"));
  expect((await f.client.sessions({ cwd: "/a", limit: 1 })).map(s => s.session)).toEqual(["older"]);
});

test("models returns live options for a live session and cached options otherwise", async () => {
  const f = await fixture();
  expect(await f.client.models()).toMatchObject({ configOptions: null }); expect(f.children).toHaveLength(0);
  const run = await f.client.start({ task: "catalog" }); await f.terminal(run);
  expect(await f.client.models(run.session)).toMatchObject({ source: "live", configOptions: expect.any(Array) });
  await f.client.close(run.session);
  expect(await f.client.models(run.session)).toMatchObject({ source: "cached" });
  expect((await f.trace()).filter(t => t.method === "session/new")).toHaveLength(1);
});

test("session idle timer closes the session; child idle timer shuts the child down", async () => {
  let time = 0;
  const closeGate = "idle-close-completion";
  const f = await fixture({ closeGate }, { now: () => time }); f.cfg.sessionIdleMinutes = 1; f.cfg.childIdleMinutes = 1;
  const run = await f.client.start({ task: "idle" });
  expect(await f.terminal(run)).toMatchObject({ status: "final", reply: "fixture reply" });
  time = 60_001;
  const gate = await until(async () => (await f.trace()).find(t => t.method === "close-gate" && t.params.sessionId === run.session && t.params.name === closeGate));
  expect(gate.params).toEqual({ sessionId: run.session, name: closeGate });
  // A close trace marks entry, not completion. Join the timer's close before advancing time.
  let closeCompleted = false;
  const closing = f.client.close(run.session).then(() => { closeCompleted = true; });
  try {
    expect((await f.trace()).filter(t => t.method === "session/close").map(t => t.params.sessionId)).toEqual([run.session]);
    expect(closeCompleted).toBe(false);
  } finally { await f.release(closeGate); await closing; }
  expect((await f.trace()).some(t => t.method === "EOF")).toBe(false);
  time = 120_002;
  await until(async () => (await f.trace()).some(t => t.method === "EOF"));
  expect(await f.children[0]!.exited).toBe(0);
  expect(f.children).toHaveLength(1);
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/new")).toHaveLength(1);
  expect(trace.filter(t => t.method === "session/close").map(t => t.params.sessionId)).toEqual([run.session]);
});

test("shutdown resolves pending, closes sessions, then ends the child within the deadlines", async () => {
  const f = await fixture({ prompts: [{ permission: "after" }] });
  const run = await f.client.start({ task: "shutdown pending" }); await f.permission(run.session);
  const stopped = f.client.shutdown();
  await expect(f.client.start({ task: "during shutdown" })).rejects.toThrow("shutting down");
  await stopped; expect(f.pending.list(run.session)).toEqual([]);
  const trace = await f.trace();
  expect(trace.findIndex(t => t.method === "permission-result")).toBeLessThan(trace.findIndex(t => t.method === "session/close"));
  expect(trace.findIndex(t => t.method === "session/close")).toBeLessThan(trace.findIndex(t => t.method === "EOF"));
  expect(await f.children[0]!.exited).toBe(0);
});

test("shutdown deadlines handle a hung close and EOF, then TERM and KILL and reap", async () => {
  const f = await fixture({ hangClose: true, hangEof: true, ignoreTerm: true });
  const run = await f.client.start({ task: "hung shutdown" }); await f.terminal(run);
  const start = Date.now(); await f.client.shutdown(); const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(11_800); expect(elapsed).toBeLessThan(15_000);
  const trace = await f.trace();
  expect(trace.map(t => t.method)).toContain("EOF"); expect(trace.map(t => t.method)).toContain("SIGTERM");
  expect(await f.children[0]!.exited).not.toBe(0);
}, 20_000);

test("malformed journal remains an explicit follow and history error", async () => {
  const f = await fixture(); const run = await f.client.start({ task: "journal error" }); await f.terminal(run);
  await appendFile(join(f.cfg.stateDir, "sessions", `${run.session}.jsonl`), '{"t":"unsupported","at":1}\n');
  await expect(f.client.follow({ ...run, after: 0, waitSeconds: 0 })).rejects.toBeInstanceOf(JournalReadError);
  await expect(f.journal.history(run.session)).rejects.toBeInstanceOf(JournalReadError);
});

test("regression: characterization: start waits for the actual SDK prompt write but not its response; cancel follows on the wire", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const wire: string[] = [];
  const f = await fixture({ prompts: [{ delay: 200 }] }, { holdPrompt: { gate: gate.promise, entered: entered.resolve, wire } });
  cleanups.push(async () => { gate.resolve(); });
  let returned = false;
  const started = f.client.start({ task: "controlled exact submission" }).then(run => { returned = true; return run; });
  await entered.promise;
  await Bun.sleep(20);
  try { expect(returned).toBe(false); expect(wire).not.toContain("session/prompt"); }
  finally { gate.resolve(); }
  const run = await started;
  expect(wire).toContain("session/prompt");
  expect((await f.client.follow({ ...run, after: 0, waitSeconds: 0 })).status).not.toBe("final");
  await f.client.cancel(run.session);
  expect(wire.indexOf("session/prompt")).toBeLessThan(wire.indexOf("session/cancel"));
  expect((await f.terminal(run)).status).toBe("cancelled");
  expect((await f.trace()).filter(t => t.method === "session/prompt")[0]?.params.prompt).toEqual([{ type: "text", text: "controlled exact submission" }]);
});

test("MCP mount failure is surfaced before any prompt", async () => {
  const f = await fixture({ mountFailure: true });
  await expect(f.client.start({ task: "must not prompt after mount failure" })).rejects.toThrow("MCP mount failed");
  expect((await f.trace()).some(t => t.method === "session/prompt")).toBe(false);
});

test("follow long-poll wakes on an update with the next durable cursor", async () => {
  const f = await fixture({ prompts: [{ delay: 150 }] });
  const run = await f.client.start({ task: "long poll exact task" });
  const initial = await f.client.follow({ ...run, after: 0, waitSeconds: 0 });
  const polled = await f.client.follow({ ...run, after: initial.next, waitSeconds: 2 });
  expect(polled.next).toBeGreaterThan(initial.next);
  expect(polled.events.find(e => e.kind === "text")?.text).toBe("fixture reply");
});

test("a permission arriving after cancellation cannot open a new wait", async () => {
  const f = await fixture({ permissionDelay: 100, prompts: [{ permission: "after" }] });
  const run = await f.client.start({ task: "cancel before permission" });
  await f.client.cancel(run.session);
  await until(async () => (await f.trace()).some(t => t.method === "session/cancel"));
  await Bun.sleep(180);
  expect(f.pending.list(run.session)).toEqual([]);
  expect((await f.terminal(run)).status).toBe("cancelled");
  expect((await f.trace()).find(t => t.method === "permission-result")?.params.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
});

test("regression: fresh server does not recover a per-session model catalog from the journal", async () => {
  const f = await fixture(); const run = await f.client.start({ task: "cache catalog" }); await f.terminal(run);
  const fresh = f.createClient();
  expect(await fresh.models(run.session)).toMatchObject({ configOptions: null, hint: expect.stringContaining("session") });
  expect(await fresh.models()).toMatchObject({ configOptions: null });
  expect(f.children).toHaveLength(1);
  expect((await f.trace()).filter(t => t.method === "session/new")).toHaveLength(1);
});

test("persisted busy errors never fall back to session/new", async () => {
  const f = await fixture({ sessions: [{ sessionId: "busy", cwd: "/busy" }], rejectResume: "session is busy elsewhere" });
  await expect(f.client.start({ session: "busy", task: "must not fork" })).rejects.toBeInstanceOf(f.api.BusyElsewhere);
  expect((await f.trace()).some(t => t.method === "session/new")).toBe(false);
});

test("stderr stays private and bounded and filters only expected overlay warnings", async () => {
  const f = await fixture({ stderr: "x".repeat(90_000) + '\nui-chat not found\nui-theme not found\nui-settings-general not found\nkeep diagnostic\n' });
  const run = await f.client.start({ task: "stderr fixture" }); await f.terminal(run); await f.client.shutdown();
  expect(f.children[0]!.lastStderrLines(10)).toContain("keep diagnostic");
  expect(f.children[0]!.lastStderrLines(10).some(l => l.includes("not found"))).toBe(false);
  expect(f.children[0]!.lastStderrLines(0)).toEqual([]);
  const logs = await Array.fromAsync(new Bun.Glob("*.stderr.log").scan({ cwd: f.cfg.stateDir, absolute: true }));
  expect(logs).toHaveLength(1);
  const info = await stat(logs[0]!); expect(info.mode & 0o777).toBe(0o600); expect(info.size).toBeLessThanOrEqual(65_536);
});

test("events preserve cursor identity and decode the ACP update classes", async () => {
  const { toFollowEvents } = await import("../src/acp/events");
  const updates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "visible" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } },
    { sessionUpdate: "tool_call", toolCallId: "exact", title: "Read", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "exact", status: "completed" },
    { sessionUpdate: "config_option_update", configOptions: [] },
    { sessionUpdate: "usage_update", used: 2 },
  ];
  const events = toFollowEvents(updates.map((update, i) => ({ seq: 10 + i, rec: { t: "update", update, at: i } })));
  expect(events.map(e => e.kind)).toEqual(["text", "thought", "tool_call", "tool_result", "config", "usage"]);
  expect(events.map(e => e.seq)).toEqual([10, 11, 12, 13, 14, 15]); expect(events[0]?.text).toBe("visible");
});

test("regression: characterization: resume boundary is typed, durable and strictly validated", async () => {
  const f = await fixture();
  const record = { t: "resumed" as const, version: 1 as const, at: 1 };
  await f.journal.append("boundary", record);
  expect((await f.journal.read("boundary", 0)).records).toEqual([record]);
  expect(await f.journal.history("boundary")).toEqual([]);
  await appendFile(join(f.cfg.stateDir, "sessions", "boundary.jsonl"), '{"t":"resumed","version":2,"at":2}\n');
  await expect(f.journal.read("boundary", 0)).rejects.toBeInstanceOf(JournalReadError);
});

const lifecycleAgent = "fake-acp-lifecycle-agent.ts";
const observed = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
async function finishes(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer!); }
}
const catalogValue = (result: { configOptions: unknown }) => (result.configOptions as Array<{ id: string; currentValue: string }> | null)?.find(o => o.id === "model")?.currentValue;

test("regression: all concurrent first-use callers await initialized SDK connection", async () => {
  const f = await fixture({ gates: ["initialize"], sessions: [{ sessionId: "external", cwd: "/external" }] }, { agent: lifecycleAgent });
  const first = observed(f.client.start({ task: "first initialization" }));
  await until(async () => (await f.trace()).find(t => t.method === "gate-enter" && t.params.name === "initialize"));
  const listing = observed(f.client.sessions({}));
  const resumed = observed(f.client.start({ session: "external", task: "parallel resume" }));
  try { await Bun.sleep(30); }
  finally { await f.release("initialize"); }
  const results = await Promise.all([first, listing, resumed]);
  expect(results.map(r => r.ok)).toEqual([true, true, true]);
  const trace = await f.trace();
  const initialized = trace.findIndex(t => t.method === "initialize-done");
  expect(initialized).toBeGreaterThanOrEqual(0);
  expect(trace.filter(t => t.method === "session/list").every(t => t.params.initialized)).toBe(true);
  for (const result of [results[0]!, results[2]!]) if (result.ok) expect((await f.terminal(result.value)).status).toBe("final");
});

test("regression: transport-only stdout death reaps its still-live child before replacement", async () => {
  const transportEnded = Promise.withResolvers<void>();
  const f = await fixture({ closeStdout: true }, { agent: lifecycleAgent, transportEnded: transportEnded.resolve });
  const run = await f.client.start({ task: "healthy before stdout closes" });
  expect(await f.terminal(run)).toMatchObject({ status: "final", reply: "reply:healthy before stdout closes" });
  let originalExited = false;
  void f.children[0]!.exited.then(() => { originalExited = true; });
  expect(await finishes(transportEnded.promise, 5000)).toBe(true);
  await Bun.sleep(80);
  expect(await f.client.sessions({})).toEqual([]);
  expect(f.children).toHaveLength(2);
  expect(originalExited).toBe(true);
  expect((await f.trace()).filter(t => t.method === "session/prompt")).toHaveLength(1);
});

test("regression: submitted lasts until a run-scoped inbound update, then running and terminal take precedence", async () => {
  const task = "exact activity transition";
  const f = await fixture({ gates: [`prompt-enter:${task}`, `prompt-update:${task}`] }, { agent: lifecycleAgent });
  const run = await f.client.start({ task });
  try {
    await until(async () => (await f.trace()).find(t => t.method === "session/prompt" && t.params.sessionId === run.session && t.params.task === task));
    const before = await f.client.follow({ ...run, after: 0, waitSeconds: 0 });
    const records = (await f.journal.read(run.session, 0)).records;
    expect(records.some(r => r.t === "update" && r.runId === run.runId)).toBe(false);
    expect(records.some(r => r.t === "update" && r.runId === undefined)).toBe(true);
    expect(String(before.status)).toBe("submitted");
    await f.release(`prompt-enter:${task}`);
    await until(async () => (await f.trace()).find(t => t.method === "prompt-update" && t.params.sessionId === run.session));
    const running = await f.client.follow({ ...run, after: before.next, waitSeconds: 0 });
    expect(running.status).toBe("running");
    expect(running.events.find(e => e.kind === "text")?.text).toBe(`reply:${task}`);
    await f.release(`prompt-update:${task}`);
    expect((await f.terminal(run)).status).toBe("final");
  } finally { await f.release(`prompt-enter:${task}`); await f.release(`prompt-update:${task}`); }
});

const stopReasons = ["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"] as const satisfies readonly StopReason[];
for (const stopReason of stopReasons) test(`regression: ${stopReason === "end_turn" || stopReason === "cancelled" ? "characterization: " : ""}SDK stop reason ${stopReason} retains partial reply and never invents success`, async () => {
  const f = await fixture({ prompts: [{ stopReason, updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `partial:${stopReason}` } }] }] });
  const run = await f.client.start({ task: `stop:${stopReason}` });
  const result = await f.terminal(run);
  expect(result.reply).toBe(`partial:${stopReason}`);
  expect(result.status).toBe(stopReason === "end_turn" ? "final" : stopReason === "cancelled" ? "cancelled" : "error");
  const settled = (await f.journal.read(run.session, 0)).records.find(r => r.t === "settled" && r.runId === run.runId);
  expect(settled).toMatchObject({ t: "settled", runId: run.runId, stopReason, status: result.status });
  if (result.status === "error") expect(result.error).toContain(stopReason);
});

test("regression: model fallback is the last successful new or resume catalog, never the first or requested closed session", async () => {
  const f = await fixture({ catalogs: ["fixture/default", "fixture/alternate", "fixture/resumed"] }, { agent: lifecycleAgent });
  const first = await f.client.start({ task: "first catalog" }); await f.terminal(first);
  const last = await f.client.start({ task: "last catalog" }); await f.terminal(last);
  expect(catalogValue(await f.client.models(first.session))).toBe("fixture/default");
  expect(await f.client.models(last.session)).toMatchObject({ source: "live" });
  expect(catalogValue(await f.client.models(last.session))).toBe("fixture/alternate");
  const checks = [];
  checks.push(await f.client.models());
  checks.push(await f.client.models("never-seen"));
  await f.client.close(first.session); await f.client.close(last.session);
  checks.push(await f.client.models(first.session));
  checks.push(await f.client.models(last.session));
  checks.push(await f.client.models());
  const resumed = await f.client.start({ session: first.session, task: "resumed catalog" }); await f.terminal(resumed);
  const afterResume = await f.client.models();
  await f.client.close(first.session);
  const closedAfterResume = await f.client.models(last.session);
  expect({ fallbacks: checks.map(result => ({ value: catalogValue(result), source: "source" in result ? result.source : undefined })), resumed: catalogValue(afterResume), closedAfterResume: catalogValue(closedAfterResume) }).toEqual({ fallbacks: Array.from({ length: 5 }, () => ({ value: "fixture/alternate", source: "cached" })), resumed: "fixture/resumed", closedAfterResume: "fixture/resumed" });
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/new-enter")).toHaveLength(2);
  expect(trace.filter(t => t.method === "session/resume-enter")).toHaveLength(1);
});

test("regression: idle eligibility is rechecked after a configuring start releases the session lock", async () => {
  let time = 0;
  const task = "new active run";
  const f = await fixture({ gates: ["config", `prompt-update:${task}`] }, { agent: lifecycleAgent, now: () => time });
  f.cfg.sessionIdleMinutes = 1;
  const old = await f.client.start({ task: "idle positive control" }); await f.terminal(old);
  const starting = observed(f.client.start({ session: old.session, task, model: "fixture/alternate" }));
  try {
    await until(async () => (await f.trace()).find(t => t.method === "gate-enter" && t.params.name === "config"));
    time = 60_001;
    await Bun.sleep(220);
    await f.release("config");
    const started = await starting;
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await until(async () => (await f.trace()).find(t => t.method === "prompt-update" && t.params.task === task));
    await Bun.sleep(150);
    expect((await f.client.follow({ ...started.value, after: 0, waitSeconds: 0 })).status).toBe("running");
    expect((await f.trace()).filter(t => t.method === "session/close" && t.params.sessionId === old.session)).toHaveLength(0);
    await f.release(`prompt-update:${task}`);
    expect((await f.terminal(started.value)).status).toBe("final");
    time = 120_002;
    await until(async () => (await f.trace()).find(t => t.method === "session/close" && t.params.sessionId === old.session));
  } finally { await f.release("config"); await f.release(`prompt-update:${task}`); await starting; }
});

test("regression: characterization: idle excludes pending work and resumes normal expiry after settlement", async () => {
  let time = 0;
  const f = await fixture({ prompts: [{ permission: "after" }] }, { now: () => time });
  f.cfg.sessionIdleMinutes = 1;
  const run = await f.client.start({ task: "pending survives idle" }); const item = await f.permission(run.session);
  time = 60_001; await Bun.sleep(220);
  expect((await f.client.follow({ ...run, after: 0, waitSeconds: 0 })).status).toBe("waiting");
  expect(f.pending.list(run.session).map(p => p.requestId)).toEqual([item.requestId]);
  expect((await f.trace()).some(t => t.method === "session/close")).toBe(false);
  await f.client.answer({ session: run.session, requestId: item.requestId, choice: "allow-once" }); await f.terminal(run);
  time = 120_002;
  await until(async () => (await f.trace()).find(t => t.method === "session/close" && t.params.sessionId === run.session));
});

test("regression: sessions public activity resets child idle clock and genuinely idle child still exits", async () => {
  let time = 0;
  const f = await fixture({ sessions: [{ sessionId: "persisted", cwd: "/persisted" }] }, { now: () => time });
  f.cfg.childIdleMinutes = 1;
  expect(await f.client.sessions({})).toEqual([expect.objectContaining({ session: "persisted", liveHere: false })]);
  time = 59_999;
  expect((await f.client.sessions({}))[0]?.session).toBe("persisted");
  time = 60_001; await Bun.sleep(220);
  expect((await f.trace()).some(t => t.method === "EOF")).toBe(false);
  expect(f.children).toHaveLength(1);
  time = 120_000;
  await until(async () => (await f.trace()).find(t => t.method === "EOF"));
  expect(await f.children[0]!.exited).toBe(0);
});

for (const operation of ["session/new", "session/resume"] as const) test(`regression: child idle cannot kill in-progress ${operation} setup`, async () => {
  let time = 0;
  const f = await fixture({ gates: [operation], sessions: [{ sessionId: "saved", cwd: "/saved" }] }, { agent: lifecycleAgent, now: () => time });
  f.cfg.childIdleMinutes = 1;
  await f.client.sessions({});
  const start = observed(f.client.start({ task: "setup must remain owned", ...(operation === "session/resume" ? { session: "saved" } : {}) }));
  try {
    await until(async () => (await f.trace()).find(t => t.method === `${operation}-enter`));
    time = 60_001; await Bun.sleep(220);
    const eof = (await f.trace()).some(t => t.method === "EOF");
    await f.release(operation);
    const result = await start;
    expect({ eof, ok: result.ok }).toEqual({ eof: false, ok: true });
    if (result.ok) expect((await f.terminal(result.value)).status).toBe("final");
  } finally { await f.release(operation); await start; }
});

for (const operation of ["session/new", "session/resume"] as const) test(`regression: shutdown owns a pending ${operation} response and closes its exact late-created session before EOF`, async () => {
  const f = await fixture({ gates: [operation], finishSetupOnEof: true, sessions: [{ sessionId: "saved", cwd: "/saved" }] }, { agent: lifecycleAgent });
  const starting = observed(f.client.start({ task: "setup during stop", ...(operation === "session/resume" ? { session: "saved" } : {}) }));
  const entered = await until(async () => (await f.trace()).find(t => t.method === `${operation}-enter`));
  const stopping = observed(f.client.shutdown());
  try { await Bun.sleep(30); }
  finally { await f.release(operation); }
  const result = await starting;
  expect(await finishes(stopping, 8000)).toBe(true);
  expect(await stopping).toMatchObject({ ok: true });
  if (!result.ok) expect(result.error).toMatch(/shutting down|ACP.*closed|connection.*closed/i);
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/prompt")).toHaveLength(0);
  const close = trace.findIndex(t => t.method === "session/close" && t.params.sessionId === entered.params.sessionId);
  expect(close).toBeGreaterThan(trace.findIndex(t => t.method === `${operation}-done`));
  expect(close).toBeLessThan(trace.findIndex(t => t.method === "EOF"));
});

test("regression: characterization: shutdown waits for pending configure without submitting a new prompt", async () => {
  const f = await fixture({ gates: ["config"] }, { agent: lifecycleAgent });
  const first = await f.client.start({ task: "configuration control" }); await f.terminal(first);
  const start = observed(f.client.start({ session: first.session, task: "must not prompt during stop", model: "fixture/alternate" }));
  await until(async () => (await f.trace()).find(t => t.method === "session/set_config_option-enter" && t.params.sessionId === first.session));
  const stop = observed(f.client.shutdown());
  try { await Bun.sleep(30); }
  finally { await f.release("config"); }
  expect(await start).toMatchObject({ ok: false, error: expect.stringContaining("shutting down") });
  expect(await stop).toMatchObject({ ok: true });
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/prompt")).toHaveLength(1);
  expect(trace.findIndex(t => t.method === "session/set_config_option-done")).toBeLessThan(trace.findIndex(t => t.method === "session/close"));
  expect(trace.findIndex(t => t.method === "session/close")).toBeLessThan(trace.findIndex(t => t.method === "EOF"));
});

test("regression: hung initialize cannot block bounded EOF TERM KILL and reap", async () => {
  const healthy = await fixture({}, { agent: lifecycleAgent });
  const control = await healthy.client.start({ task: "lifecycle transport control" });
  expect((await healthy.terminal(control)).reply).toBe("reply:lifecycle transport control");
  await healthy.client.shutdown();
  const f = await fixture({ gates: ["initialize"], hangEof: true, ignoreTerm: true }, { agent: lifecycleAgent });
  const start = observed(f.client.start({ task: "never initialized" }));
  await until(async () => (await f.trace()).find(t => t.method === "gate-enter" && t.params.name === "initialize"));
  const stop = observed(f.client.shutdown());
  try {
    expect(await finishes(stop, 23_000)).toBe(true);
    const trace = await f.trace();
    expect(trace.some(t => t.method === "initialize-done")).toBe(false);
    expect(trace.map(t => t.method)).toContain("EOF");
    expect(trace.map(t => t.method)).toContain("SIGTERM");
    expect(await f.children[0]!.exited).not.toBe(0);
  } finally {
    await f.release("initialize");
    await f.children[0]!.shutdown();
    await start; await stop;
  }
}, 35_000);

test("regression: every session pending item is cancelled durably before the first close even if that close stalls", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const snapshots: Array<{ session: string; pending: string[]; answers: string[] }> = [];
  const sessions: string[] = [];
  const requestIds: string[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ prompts: [{ permission: "after" }, { question: "other session must cancel first" }] }, { bridgeWaitMs: 100, wire: async message => {
    if (message.method !== "session/close") return;
    const answers: string[] = [];
    for (const session of sessions) for (const rec of (await f.journal.read(session, 0)).records) if (rec.t === "answer" && (rec.answer as { cancelled?: boolean }).cancelled) answers.push(rec.requestId);
    snapshots.push({ session: message.params.sessionId, pending: sessions.flatMap(session => f.pending.list(session).map(p => p.requestId)), answers });
    if (snapshots.length === 1) { entered.resolve(); await gate.promise; }
  } });
  for (let i = 0; i < 2; i++) {
    const run = await f.client.start({ task: `global stop ${i}` }); sessions.push(run.session);
    const item = i === 0 ? await f.permission(run.session) : await f.question(run.session); requestIds.push(item.requestId);
  }
  const stopping = observed(f.client.shutdown());
  try {
    await entered.promise;
    expect(snapshots[0]?.pending).toEqual([]);
    expect(snapshots[0]?.answers.sort()).toEqual([...requestIds].sort());
  } finally { gate.resolve(); await stopping; }
});

test("regression: characterization: four hung closes obey the aggregate fifteen second budget then EOF and reap", async () => {
  const f = await fixture({ hangClose: true }, { agent: lifecycleAgent });
  const sessions: string[] = [];
  for (let i = 0; i < 4; i++) { const run = await f.client.start({ task: `aggregate ${i}` }); await f.terminal(run); sessions.push(run.session); }
  const began = Date.now(); await f.client.shutdown(); const elapsed = Date.now() - began;
  const trace = await f.trace();
  expect(elapsed).toBeGreaterThanOrEqual(4_800); expect(elapsed).toBeLessThan(17_000);
  const closes = trace.filter(t => t.method === "session/close");
  expect(closes.length).toBeGreaterThan(0);
  expect(closes.every(t => sessions.includes(t.params.sessionId))).toBe(true);
  const eof = trace.findIndex(t => t.method === "EOF");
  expect(eof).toBeGreaterThanOrEqual(0);
  expect(trace.every((t, index) => t.method !== "session/close" || index < eof)).toBe(true);
  expect(await f.children[0]!.exited).toBe(0);
}, 22_000);

test("regression: characterization: submitted-only orphan journal is unknown, never replayed, and expires at resume boundary", async () => {
  const session = "genuine-orphan"; const runId = "submitted-with-no-settlement";
  const f = await fixture({ sessions: [{ sessionId: session, cwd: "/orphan/cwd" }] });
  await f.journal.append(session, { t: "submitted", runId, task: "do not replay this task", at: 1 });
  const orphan = await f.client.follow({ session, runId, after: 0, waitSeconds: 0 });
  expect(orphan).toMatchObject({ status: "unknown", reply: "", pending: [] });
  expect(f.children).toHaveLength(0);
  expect((await f.journal.read(session, 0)).records).toEqual([{ t: "submitted", runId, task: "do not replay this task", at: 1 }]);
  const next = await f.client.start({ session, task: "explicit recovery task" }); await f.terminal(next);
  expect(next.runId).not.toBe(runId);
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/prompt").map(t => t.params.prompt)).toEqual([[{ type: "text", text: "explicit recovery task" }]]);
  expect(trace.find(t => t.method === "session/resume")?.params.cwd).toBe("/orphan/cwd");
  await expect(f.createClient().follow({ session, runId, after: 0, waitSeconds: 0 })).rejects.toMatchObject({ name: "UnknownRequest", message: "Run handle expired by session resume" });
});

test("regression: characterization: omitted resume cwd comes from the exact session on a later list page", async () => {
  const f = await fixture({ sessions: [{ sessionId: "first-page", cwd: "/wrong-first-page" }, { sessionId: "later-page", cwd: "/exact/persisted/cwd" }] });
  const run = await f.client.start({ session: "later-page", task: "resume exact cwd" });
  expect((await f.terminal(run)).status).toBe("final");
  const trace = await f.trace();
  expect(trace.filter(t => t.method === "session/list").map(t => t.params.cursor ?? null)).toEqual([null, "1"]);
  expect(trace.find(t => t.method === "session/resume")?.params).toMatchObject({ sessionId: "later-page", cwd: "/exact/persisted/cwd" });
  expect(trace.some(t => t.method === "session/new")).toBe(false);
});

for (const kind of ["allow_once", "allow_always"] as const) test(`regression: characterization: automatic permissions choose unusual option ID by ${kind} kind`, async () => {
  const allowed = `opaque-accept-${kind}-73`;
  const f = await fixture({ prompts: [{ permission: "after", permissionOptions: [{ optionId: "allow-once", name: "Misleading ID", kind: "reject_once" }, { optionId: allowed, name: "Accept", kind }] }] }, { permissions: "allow" });
  const run = await f.client.start({ task: `kind:${kind}` }); expect((await f.terminal(run)).status).toBe("final");
  expect((await f.trace()).find(t => t.method === "permission-result")?.params).toEqual({ outcome: { outcome: "selected", optionId: allowed } });
  expect((await f.journal.read(run.session, 0)).records).toContainEqual(expect.objectContaining({ t: "permission", runId: run.runId, auto: true }));
  expect(f.pending.list(run.session)).toEqual([]);
});

test("regression: characterization: settlement cancels an unanswered question and a later answer is expired, not already answered by the lead", async () => {
  const f = await fixture({ prompts: [{ question: "unanswered at settlement", settleWithQuestion: true }] }, { bridgeWaitMs: 100 });
  const run = await f.client.start({ task: "settle outstanding item" });
  const q = await f.question(run.session);
  expect((await f.terminal(run)).status).toBe("final");
  const answers = (await f.journal.read(run.session, 0)).records.filter(r => r.t === "answer" && r.requestId === q.requestId);
  expect(answers).toEqual([expect.objectContaining({ answer: { cancelled: true } })]);
  expect(f.pending.list(run.session)).toEqual([]);
  await expect(f.client.answer({ session: run.session, requestId: q.requestId, text: "too late" })).rejects.toMatchObject({ name: "UnknownRequest", message: `Unknown or expired request ${q.requestId}` });
});

test("regression: characterization: cancel releases an active real lead wait and records cancellation before ACP cancel", async () => {
  const f = await fixture({ prompts: [{ question: "cancel real wait", cancelDelay: 100 }] }, { bridgeWaitMs: 100 });
  const run = await f.client.start({ task: "question cancellation" }); const q = await f.question(run.session);
  await until(async () => (await f.trace()).find(t => t.method === "wait-result" && t.params.questionId === q.requestId && t.params.status === "pending"));
  expect((await f.client.follow({ ...run, after: 0, waitSeconds: 0 })).status).toBe("waiting");
  await f.client.cancel(run.session);
  expect((await f.terminal(run)).status).toBe("cancelled");
  expect(f.pending.list(run.session)).toEqual([]);
  const trace = await f.trace();
  expect(trace.find(t => t.method === "wait-result" && t.params.status === "cancelled")?.params).toEqual({ status: "cancelled" });
  expect((await f.journal.read(run.session, 0)).records).toContainEqual(expect.objectContaining({ t: "answer", requestId: q.requestId, answer: { cancelled: true } }));
});

async function socketPeer(path: string, token: string) {
  const socket: Socket = createConnection(path);
  const replies: any[] = []; let text = ""; let closed = false;
  socket.on("error", () => {});
  socket.on("close", () => { closed = true; });
  socket.on("data", bytes => {
    text += bytes.toString();
    let end: number;
    while ((end = text.indexOf("\n")) >= 0) { replies.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
  });
  cleanups.push(async () => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const send = (value: unknown) => { socket.write(JSON.stringify(value) + "\n"); };
  send({ hello: 1, token });
  return { send, replies, closed: () => closed };
}

test("regression: failed new and resume revoke only their allocated token and disconnect authenticated unbound peers", async () => {
  const peers: Awaited<ReturnType<typeof socketPeer>>[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ mountFailure: true, sessions: [{ sessionId: "failed-resume", cwd: "/saved" }] }, { wire: async message => {
    if (!["session/new", "session/resume"].includes(message.method)) return;
    const args: string[] = message.params.mcpServers[0].args;
    const peer = await socketPeer(args[args.indexOf("--socket") + 1]!, args[args.indexOf("--token") + 1]!);
    peers.push(peer);
    peer.send({ id: "unbound-control", tool: "notify_lead", args: { text: "must be unbound" } });
    const reply = await until(async () => peer.replies.find(r => r.id === "unbound-control"));
    expect(reply.error).toBe("token is not bound");
  } });
  const path = await f.bridge.listen();
  const retained = f.bridge.allocateToken(); f.bridge.bindToken(retained, "unrelated-control");
  const control = await socketPeer(path, retained);
  const errors = [];
  errors.push(await observed(f.client.start({ task: "failed new" })));
  errors.push(await observed(f.client.start({ task: "failed resume", session: "failed-resume" })));
  await Bun.sleep(30);
  expect(errors).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ ok: false, error: expect.stringContaining("MCP mount failed") })));
  control.send({ id: "surviving-control", tool: "notify_lead", args: { text: "still bound correctly" } });
  expect(await until(async () => control.replies.find(r => r.id === "surviving-control"))).toMatchObject({ result: { ok: true } });
  const tokens = (f.bridge as unknown as { tokens: Map<string, unknown> }).tokens;
  expect(tokens.has(retained)).toBe(true);
  expect({ tokenCount: tokens.size, disconnected: peers.map(peer => peer.closed()) }).toEqual({ tokenCount: 1, disconnected: [true, true] });
  expect((await f.trace()).some(t => t.method === "session/prompt")).toBe(false);
});

test("regression: late lead questions cannot reopen pending work once shutdown begins", async () => {
  const closeGate = Promise.withResolvers<void>(); const closeEntered = Promise.withResolvers<void>();
  const f = await fixture({ prompts: [{ question: "late stopping question", questionGate: "late-question" }] }, { bridgeWaitMs: 100, wire: async message => {
    if (message.method === "session/close") { closeEntered.resolve(); await closeGate.promise; }
  } });
  const run = await f.client.start({ task: "question arrives during stop" });
  await until(async () => (await f.trace()).find(t => t.method === "question-gate" && t.params.sessionId === run.session));
  const stop = observed(f.client.shutdown());
  try {
    await closeEntered.promise;
    await f.release("late-question");
    const response = await until(async () => (await f.trace()).find(t => t.method === "ask-result"));
    expect(f.pending.list(run.session)).toEqual([]);
    expect(response.params.status).toBe("cancelled");
  } finally { await f.release("late-question"); closeGate.resolve(); await stop; }
});

test("regression: late permission cannot reopen pending work once shutdown begins", async () => {
  // Hold the agent's close completion, not the SDK writer needed for permission replies.
  const f = await fixture({ closeGate: "late-permission-close", prompts: [{ permission: "after", permissionGate: "late-permission" }] });
  const run = await f.client.start({ task: "permission arrives during stop" });
  await until(async () => (await f.trace()).find(t => t.method === "permission-gate" && t.params.sessionId === run.session));
  let stopped = false;
  const stop = observed(f.client.shutdown()).then(result => { stopped = true; return result; });
  try {
    const close = await until(async () => (await f.trace()).find(t => t.method === "close-gate" && t.params.sessionId === run.session && t.params.name === "late-permission-close"));
    expect(close.params).toEqual({ sessionId: run.session, name: "late-permission-close" });
    await f.release("late-permission");
    await until(async () => f.pending.list(run.session).find(p => p.kind === "permission" && p.toolCallId === "tool-exact-1") || (await f.trace()).find(t => t.method === "permission-result"));
    const pending = f.pending.list(run.session);
    expect(pending).toEqual([]);
    const result = await until(async () => (await f.trace()).find(t => t.method === "permission-result"));
    expect(result.params).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(stopped).toBe(false);
  } finally { await f.release("late-permission"); await f.release("late-permission-close"); await stop; }
});

test("regression: startup failure exposes filtered nonsecret stderr sentinel through the client error", async () => {
  const sentinel = "fake-startup-diagnostic-sentinel: overlay initialization failed";
  const f = await fixture({ stderr: `${sentinel}\nui-chat not found\nui-theme not found\nui-settings-general not found\n`, gates: ["initialize"] }, { agent: lifecycleAgent });
  const start = observed(f.client.start({ task: "startup diagnostics" }));
  await until(async () => (await f.trace()).find(t => t.method === "gate-enter" && t.params.name === "initialize"));
  await f.children[0]!.shutdown();
  const result = await start;
  const files = await Array.fromAsync(new Bun.Glob("*.stderr.log").scan({ cwd: f.cfg.stateDir, absolute: true }));
  expect(files).toHaveLength(1);
  expect(await Bun.file(files[0]!).text()).toContain(sentinel);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain(sentinel);
    expect(result.error).not.toMatch(/ui-chat|ui-theme|ui-settings-general/);
  }
});

test("regression: fake-only headers and token values are redacted before stderr persistence or client diagnostics", async () => {
  const secrets = ["fake-bearer-value-NEVER-REAL", "fake-api-key-NEVER-REAL", "fake-bridge-token-NEVER-REAL"];
  const sentinel = "nonsecret diagnostic class ECONNRESET";
  const f = await fixture({ stderr: `${sentinel}\nAuthorization: Bearer ${secrets[0]}\nx-api-key: ${secrets[1]}\n--token ${secrets[2]}\n`, gates: ["initialize"] }, { agent: lifecycleAgent });
  const start = observed(f.client.start({ task: "redacted diagnostic" }));
  await until(async () => (await f.trace()).find(t => t.method === "gate-enter" && t.params.name === "initialize"));
  await f.children[0]!.shutdown();
  const result = await start;
  const files = await Array.fromAsync(new Bun.Glob("*.stderr.log").scan({ cwd: f.cfg.stateDir, absolute: true }));
  expect(files).toHaveLength(1);
  const persisted = await Bun.file(files[0]!).text();
  expect(persisted).toContain(sentinel);
  expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
  const visible = result.ok ? "unexpected startup success" : result.error;
  for (const secret of secrets) {
    expect({ secret, persisted: persisted.includes(secret), visible: visible.includes(secret), logged: f.logs.some(line => line.includes(secret)) }).toEqual({ secret, persisted: false, visible: false, logged: false });
  }
  expect(visible).toContain(sentinel);
});

for (const mode of ["configure", "resume-list"] as const) test(`regression: RPC diagnostics ${mode} keeps the captured owner's filtered redacted tail`, async () => {
  const gate = mode === "configure" ? "config" : "list";
  const sentinel = `rpc-${mode}-captured-owner-sentinel`;
  const secret = `fake-${mode}-NEVER-REAL`;
  const f = await fixture({ gates: [gate], stderr: `${"bounded padding\n".repeat(20)}${sentinel}\nAuthorization: Bearer ${secret}\nui-chat not found\n`, sessions: [{ sessionId: "diagnostic-saved", cwd: "/diagnostic/saved" }] }, { agent: lifecycleAgent });
  const control = await f.client.start({ task: `healthy-${mode}` });
  expect(await f.terminal(control)).toMatchObject({ status: "final", reply: `reply:healthy-${mode}` });
  await until(async () => f.children[0]!.lastStderrLines(10).includes(sentinel));
  const files = await Array.fromAsync(new Bun.Glob("*.stderr.log").scan({ cwd: f.cfg.stateDir, absolute: true }));
  expect(files).toHaveLength(1);
  await until(async () => (await Bun.file(files[0]!).text()).includes(sentinel));
  const persisted = await Bun.file(files[0]!).text();
  expect(persisted).toContain(sentinel);
  expect(persisted).not.toContain(secret);
  const operation = observed(f.client.start(mode === "configure" ? { session: control.session, task: "configure-transport-failure", model: "fixture/alternate" } : { session: "diagnostic-saved", task: "resume-discovery-transport-failure" }));
  try {
    await until(async () => (await f.trace()).find(row => row.method === "gate-enter" && row.params.name === gate));
    await f.children[0]!.shutdown();
    const failure = await operation;
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error).toContain(sentinel);
      expect(failure.error).toMatch(/closed/i);
      expect(failure.error).not.toMatch(/ui-chat|ui-theme|ui-settings-general/);
      expect(failure.error).not.toContain(secret);
      expect(failure.error.match(/dsh stderr:/g)).toHaveLength(1);
      expect(failure.error.length).toBeLessThan(9000);
    }
    expect((await f.trace()).filter(row => row.method === "session/prompt")).toHaveLength(1);
  } finally { await f.release(gate); await operation; }
});

for (const kind of ["busy", "cwd"] as const) test(`regression: RPC diagnostics typed resume ${kind} keeps its type and the child tail`, async () => {
  const sentinel = `typed-${kind}-rpc-sentinel`;
  const message = kind === "busy" ? "session is busy elsewhere" : "session cwd does not match: /wrong";
  const f = await fixture({ stderr: `${sentinel}\nui-chat not found\n`, rejectResume: message, sessions: [{ sessionId: "typed-saved", cwd: "/saved" }] });
  const control = await f.client.start({ task: `typed-${kind}-control` });
  expect((await f.terminal(control)).reply).toBe("fixture reply");
  await until(async () => f.children[0]!.lastStderrLines(10).includes(sentinel));
  await expect(f.client.start({ session: "typed-saved", task: "typed-resume-failure" })).rejects.toMatchObject({ name: kind === "busy" ? "BusyElsewhere" : "CwdMismatch", message: expect.stringContaining(sentinel) });
  expect((await f.trace()).filter(row => row.method === "session/new")).toHaveLength(1);
});

test("regression: RPC diagnostics explicit close deadline keeps timeout semantics and captured diagnostics", async () => {
  const sentinel = "explicit-close-deadline-sentinel";
  const f = await fixture({ stderr: `${sentinel}\n`, hangClose: true }, { agent: lifecycleAgent });
  const control = await f.client.start({ task: "close-deadline-control" });
  expect((await f.terminal(control)).reply).toBe("reply:close-deadline-control");
  await until(async () => f.children[0]!.lastStderrLines(10).includes(sentinel));
  const result = await observed(f.client.close(control.session));
  expect(result.ok).toBe(false);
  if (!result.ok) { expect(result.error).toContain("ACP operation timed out"); expect(result.error).toContain(sentinel); }
  // A close deadline must remain a deadline, not a generic shutdown failure.
  await expect(f.client.shutdown()).resolves.toBeUndefined();
}, 12_000);

test("regression: RPC diagnostics explicit cancel write failure includes the captured owner tail", async () => {
  const sentinel = "explicit-cancel-write-sentinel";
  const task = "cancel-write-control";
  const f = await fixture({ stderr: `${sentinel}\n`, gates: [`prompt-update:${task}`] }, { agent: lifecycleAgent, wire: async message => {
    if (message.method === "session/cancel") throw new Error("controlled cancel pipe failure");
  } });
  const run = await f.client.start({ task });
  await until(async () => (await f.journal.reply(run.session, run.runId)) === "reply:cancel-write-control");
  expect((await f.client.follow({ ...run, after: 0, waitSeconds: 0 })).status).toBe("running");
  await until(async () => f.children[0]!.lastStderrLines(10).includes(sentinel));
  try {
    const result = await observed(f.client.cancel(run.session));
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain("controlled cancel pipe failure"); expect(result.error).toContain(sentinel); }
  } finally { await f.release(`prompt-update:${task}`); }
});
