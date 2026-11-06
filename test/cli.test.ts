import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const usage = "usage: dsh-agents <mcp|lead-bridge|doctor>";

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
