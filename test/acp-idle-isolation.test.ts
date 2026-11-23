import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DshAcpClient } from "../src/acp/client";
import { DshChild } from "../src/acp/child";
import { Journal, JournalReadError } from "../src/journal";
import { PendingQueue } from "../src/bridge/pending";
import { BridgeSocketServer } from "../src/bridge/socket";
import { loadConfig } from "../src/config";
import type { LifecycleScript } from "./fake-acp-lifecycle-agent";

const observed = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
async function until<T>(read: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await read(); if (result) return result; await Bun.sleep(10); }
  throw new Error("scope-isolation fixture deadline");
}
async function fixture(script: LifecycleScript) {
  const dir = await mkdtemp("/tmp/dsha6iso-");
  const path = join(dir, "script.json");
  const bin = join(dir, "fake-dsh");
  await Bun.write(path, JSON.stringify(script));
  await Bun.write(bin, `#!/bin/sh\nexport FAKE_ACP_SCRIPT='${path}'\nexec '${process.execPath}' '${resolve(import.meta.dir, "fake-acp-lifecycle-agent.ts")}' "$@"\n`);
  await chmod(bin, 0o700);
  const cfg = loadConfig({ DSH_HOME: dir, DSH_AGENTS_DSH_BIN: bin, TMPDIR: dir }, () => false);
  cfg.sessionIdleMinutes = 1;
  let time = 0;
  const journal = new Journal(join(cfg.stateDir, "sessions"));
  const pending = new PendingQueue();
  const bridge = new BridgeSocketServer({ socketDir: cfg.socketDir, pending, bridgeWaitMs: 100, onNote: () => {}, log: () => {} });
  const children: DshChild[] = [];
  const client = new DshAcpClient({ cfg, journal, pending, bridge, now: () => time, spawnChild: () => {
    const child = new DshChild(cfg, () => {}); children.push(child); return child;
  } });
  const follow = (run: { session: string; runId: string }) => client.follow({ ...run, after: 0, waitSeconds: 0 });
  const terminal = (run: { session: string; runId: string }) => until(async () => { const result = await follow(run); return result.status === "final" && result; });
  const release = (name: string) => Bun.write(`${path}.release-${encodeURIComponent(name)}`, "release");
  const trace = async (): Promise<Array<{ method: string; params: any }>> => !await Bun.file(`${path}.trace`).exists() ? [] : (await Bun.file(`${path}.trace`).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const gate of script.gates ?? []) await release(gate);
    const stopped = await observed(client.shutdown());
    if (!stopped.ok) errors.push(stopped.error);
    for (const child of children) {
      const reaped = await observed(child.shutdown());
      if (!reaped.ok) errors.push(reaped.error);
      await child.exited;
    }
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
    return errors;
  };
  return { cfg, client, journal, follow, terminal, release, trace, cleanup, advance: () => { time = 60_001; } };
}

for (const hangClose of [false, true]) test(`regression: scope-isolation ${hangClose ? "idle close deadline stays visible only on its own session" : "characterization: successful sibling idle close leaves held run healthy"}`, async () => {
  const task = "held-isolation-A";
  const f = await fixture({ gates: [`prompt-update:${task}`], hangClose, afterPromptUpdate: ":after-release" });
  let primary: unknown;
  let cleanupErrors: unknown[] = [];
  try {
    const active = await f.client.start({ task });
    await until(async () => (await f.journal.reply(active.session, active.runId)) === "reply:held-isolation-A" && true);
    const sibling = await f.client.start({ task: "idle-isolation-B" });
    expect(active.session).not.toBe(sibling.session);
    expect(await f.terminal(sibling)).toMatchObject({ status: "final", reply: "reply:idle-isolation-B:after-release" });
    expect((await f.follow(active)).status).toBe("running");
    f.advance();
    await until(async () => (await f.trace()).find(row => row.method === "session/close" && row.params.sessionId === sibling.session));
    await until(async () => (await f.client.sessions({})).find(row => row.session === sibling.session && !row.liveHere));
    expect((await f.client.sessions({})).find(row => row.session === active.session)?.liveHere).toBe(true);
    expect(await f.journal.reply(active.session, active.runId)).toBe("reply:held-isolation-A");
    expect((await f.follow(active)).status).toBe("running");
    const notes = (await f.journal.read(sibling.session, 0)).records.filter(row => row.t === "note");
    if (hangClose) expect(notes).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/idle.*close.*timed out/i) }));
    else expect(notes).toEqual([]);
    expect((await f.journal.read(active.session, 0)).records.filter(row => row.t === "note")).toEqual([]);
    await f.release(`prompt-update:${task}`);
    expect(await f.terminal(active)).toMatchObject({ status: "final", reply: "reply:held-isolation-A:after-release" });
    const followup = await f.client.start({ session: active.session, task: "explicit-followup-A" });
    expect(followup.session).toBe(active.session);
    expect(followup.runId).not.toBe(active.runId);
    expect(await f.terminal(followup)).toMatchObject({ status: "final", reply: "reply:explicit-followup-A:after-release" });
    expect((await f.trace()).filter(row => row.method === "session/close" && row.params.sessionId === active.session)).toEqual([]);
  } catch (error) { primary = error; }
  finally { cleanupErrors = await f.cleanup(); }
  if (primary) throw new AggregateError([primary, ...cleanupErrors], "scope-isolation primary assertion failed");
  expect(cleanupErrors).toEqual([]);
}, 18_000);

test("regression: scope-isolation characterization: genuine local journal write error remains latched and fails shutdown", async () => {
  const task = "local-journal-write-failure";
  const f = await fixture({ gates: [`prompt-update:${task}`], afterPromptUpdate: ":must-persist" });
  let primary: unknown;
  let journalError: unknown;
  let cleanupErrors: unknown[] = [];
  let obstructed: string | undefined;
  try {
    const run = await f.client.start({ task });
    await until(async () => (await f.journal.reply(run.session, run.runId)) === "reply:local-journal-write-failure" && true);
    expect((await f.follow(run)).status).toBe("running");
    const append = f.journal.append.bind(f.journal);
    let failedWrite: unknown;
    f.journal.append = async (...args) => {
      try { return await append(...args); }
      catch (error) { failedWrite = error; throw error; }
    };
    const path = join(f.cfg.stateDir, "sessions", `${run.session}.jsonl`);
    await rename(path, `${path}.saved`);
    await mkdir(path);
    obstructed = path;
    await f.release(`prompt-update:${task}`);
    await until(async () => (await f.trace()).find(row => row.method === "gate-release" && row.params.name === `prompt-update:${task}`));
    journalError = await until(async () => failedWrite instanceof JournalReadError && failedWrite);
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    obstructed = undefined;
    expect(await f.journal.reply(run.session, run.runId)).toBe("reply:local-journal-write-failure");
    // The filesystem is healthy again; the failed write must still be reported.
    await expect(f.follow(run)).rejects.toBeInstanceOf(JournalReadError);
    const stopped = await observed(f.client.shutdown());
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) {
      expect(stopped.error).toBeInstanceOf(AggregateError);
      expect(stopped.error.errors).toContainEqual(expect.any(JournalReadError));
    }
  } catch (error) { primary = error; }
  finally {
    if (obstructed) { await rm(obstructed, { recursive: true }); await rename(`${obstructed}.saved`, obstructed); }
    cleanupErrors = await f.cleanup();
  }
  if (primary) throw new AggregateError([primary, ...cleanupErrors], "journal characterization primary assertion failed");
  expect(journalError).toBeInstanceOf(JournalReadError);
  expect(cleanupErrors).toHaveLength(1);
  expect(cleanupErrors[0]).toBeInstanceOf(AggregateError);
  expect((cleanupErrors[0] as AggregateError).errors).toContainEqual(expect.any(JournalReadError));
}, 12_000);
