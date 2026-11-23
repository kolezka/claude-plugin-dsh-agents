import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const tools = ["start", "follow", "answer", "ask", "cancel", "sessions", "history", "models", "close"];
const commands = ["answer", "ask", "follow", "history", "models", "sessions", "setup", "status"];

async function read(path: string) {
  return Bun.file(resolve(root, path)).text();
}

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("missing frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

test("plugin manifest and MCP server keep the names the tool prefix depends on", async () => {
  expect(JSON.parse(await read(".claude-plugin/plugin.json")).name).toBe("dsh");
  const mcp = JSON.parse(await read(".mcp.json"));
  expect(Object.keys(mcp.mcpServers)).toEqual(["dsh"]);
  expect(mcp.mcpServers.dsh.args).toEqual(["mcp"]);
});

test("bridge agent pins haiku and exactly the dsh tools plus SendMessage and ToolSearch", async () => {
  const text = await read("agents/dsh.md");
  const fields = frontmatter(text);
  expect(fields.name).toBe("dsh");
  expect(fields.model).toBe("haiku");
  const listed = fields.tools!.split(",").map(tool => tool.trim()).sort();
  expect(listed).toEqual(["SendMessage", "ToolSearch", ...tools.map(tool => `mcp__plugin_dsh_dsh__${tool}`)].sort());
  for (const tool of tools) expect(text).toContain(`mcp__plugin_dsh_dsh__${tool}`);
  expect(text).toContain("## In an agent team");
  expect(text).toContain("dsh (<provider/model>) replied:");
});

test("delegation skill is named after its directory and keeps the follow loop in the agent", async () => {
  const text = await read("skills/dsh-delegation/SKILL.md");
  expect(frontmatter(text).name).toBe("dsh-delegation");
  expect(text).toContain("dsh:dsh");
});

test("every command exists, is user-only and describes itself", async () => {
  const files = (await readdir(resolve(root, "commands"))).filter(file => file.endsWith(".md")).sort();
  expect(files).toEqual(commands.map(name => `${name}.md`));
  for (const file of files) {
    const fields = frontmatter(await read(`commands/${file}`));
    expect(fields["disable-model-invocation"]).toBe("true");
    expect(fields.description?.length).toBeGreaterThan(0);
  }
});

test("setup command may run only the launcher's install-deps and doctor", async () => {
  const fields = frontmatter(await read("commands/setup.md"));
  expect(fields["allowed-tools"]).toBe("Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents install-deps), Bash(${CLAUDE_PLUGIN_ROOT}/bin/dsh-agents doctor)");
});

test("plugin prose uses no en or em dash", async () => {
  const paths = ["README.md", "agents/dsh.md", "skills/dsh-delegation/SKILL.md", "docs/protocol.md", ...commands.map(name => `commands/${name}.md`)];
  for (const path of paths) {
    const text = await read(path);
    expect({ path, dash: /[–—]/.test(text) }).toEqual({ path, dash: false });
  }
});

test("launcher install-deps runs a frozen production bun install in the plugin root", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "launcher-deps-"));
  try {
    const fakeBun = resolve(dir, "bun");
    await writeFile(fakeBun, '#!/bin/sh\nprintf "%s|%s\\n" "$(pwd -P)" "$*"\n');
    await chmod(fakeBun, 0o755);
    const proc = Bun.spawn([resolve(root, "bin/dsh-agents"), "install-deps"], { cwd: dir, env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const realRoot = await realpath(root);
    expect(out.trim()).toBe(`${realRoot}|install --frozen-lockfile --production`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
