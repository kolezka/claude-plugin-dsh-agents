import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const usage = "usage: dsh-agents <mcp|lead-bridge|doctor>";

test("mcp CLI starts the server, answers initialize, and exits on EOF", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "cli-mcp-"));
  try {
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "mcp"], { cwd: root, env: { ...process.env, DSH_HOME: home, TMPDIR: home, DSH_AGENTS_DSH_BIN: "/not-a-live-dsh" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
    await proc.stdin.flush();
    const read = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("MCP did not answer initialize"); })]);
    const response = JSON.parse(new TextDecoder().decode(read.value).trim());
    expect(response.id).toBe(1);
    expect(response.result.serverInfo.name).toBe("dsh");
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect((await reader.read()).done).toBe(true);
    expect(await new Response(proc.stderr).text()).toBe("");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("mcp and doctor CLI propagate failure exit codes", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "cli-errors-"));
  try {
    const env = { ...process.env, DSH_HOME: home, TMPDIR: home, DSH_AGENTS_DSH_BIN: "/not-a-live-dsh" };
    const mcp = Bun.spawn([process.execPath, "run", "src/cli.ts", "mcp", "bad"], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await mcp.exited).toBe(2);
    expect(await new Response(mcp.stdout).text()).toBe("");
    const doc = Bun.spawn([process.execPath, "run", "src/cli.ts", "doctor"], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await doc.exited).toBe(1);
    expect((await new Response(doc.stdout).text()).toLowerCase()).toContain("install");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor CLI initializes a fake ACP process without creating a session", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "cli-doctor-"));
  try {
    await mkdir(resolve(home, "profiles/acp"), { recursive: true });
    const fake = resolve(home, "fake-dsh");
    const script = resolve(home, "script.json");
    const fixture = resolve(root, "test/fixtures/dump-config.txt");
    await Bun.write(script, "{}");
    await Bun.write(fake, `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("fake-dsh 1");\nelse if (process.argv.includes("--dump-config")) process.stdout.write(await Bun.file(${JSON.stringify(fixture)}).text());\nelse await import(${JSON.stringify(resolve(root, "test/fake-acp-agent.ts"))});\n`);
    await chmod(fake, 0o700);
    const env = { ...process.env, DSH_HOME: home, TMPDIR: home, DSH_AGENTS_DSH_BIN: fake, DSH_AGENTS_PATCH: "", FAKE_ACP_SCRIPT: script };
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "doctor"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    expect(stdout).toContain("ACP initialize: ok");
    expect(stdout).toContain("MCP rows found: 6");
    expect(stderr).toBe("");
    const trace = (await Bun.file(`${script}.trace`).text()).trim().split("\n").map(line => JSON.parse(line).method);
    expect(trace).toEqual(["initialize", "EOF"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("cli rejects an unknown subcommand with usage on stderr", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "nope"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain(usage);
  expect(await new Response(proc.stdout).text()).toBe("");
});

test("cli rejects a missing subcommand with usage on stderr", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain(usage);
  expect(await new Response(proc.stdout).text()).toBe("");
});

test("launcher works outside the plugin root and forwards arguments", async () => {
  const proc = Bun.spawn([resolve(root, "bin/dsh-agents"), "nope"], {
    cwd: "/",
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain(usage);
  expect(await new Response(proc.stdout).text()).toBe("");
});
