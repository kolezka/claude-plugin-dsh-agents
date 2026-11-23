import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/doctor";
import { loadConfig } from "../src/config";

const fixture = await Bun.file(join(import.meta.dir, "fixtures/dump-config.txt")).text();
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code });

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "doctor-test-"));
  await mkdir(join(home, "profiles/acp"), { recursive: true });
  const cfg = loadConfig({ DSH_HOME: home, DSH_AGENTS_DSH_BIN: "fake-dsh", DSH_AGENTS_PATCH: "fixture.patch" }, () => false);
  return { home, cfg };
}

test("doctor decodes all MCP and provider model metadata and the ACP route", async () => {
  const { home, cfg } = await setup();
  try {
    const rows = JSON.parse(fixture);
    rows.push({ id: "mcp-extra", config: { serverName: "extra-server" } });
    const calls: string[][] = [];
    const report = await doctor(cfg, async cmd => {
      calls.push(cmd);
      return cmd.includes("--version") ? result("dsh fixture 1") : result(JSON.stringify(rows));
    }, async () => ({ ok: true }));
    expect(report.ok).toBe(true);
    for (const row of rows.filter((r: { config: { serverName?: string } }) => r.config.serverName)) {
      expect(report.report).toContain(row.id);
      expect(report.report).toContain(row.config.serverName);
    }
    expect(report.report).toContain("gpt-6.1-sol");
    expect(report.report).toContain("deepseek-official");
    expect(report.report).toContain("deepseek-v4-flash");
    expect(report.report).toContain("fixture.patch");
    expect(report.report).toContain("initialize");
    expect(calls.some(c => c.includes("--dump-config"))).toBe(true);
    expect(calls.every(c => !c.includes("session/new"))).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor filters only expected UI warnings", async () => {
  const { home, cfg } = await setup();
  try {
    const warnings = ["ui-settings-general not found", "ui-chat not found", "ui-theme not found", "other plugin not found"].join("\n");
    const out = await doctor(cfg, async cmd => cmd.includes("--version") ? result("v1") : result(fixture, warnings), async () => ({ ok: true }));
    expect(out.report).not.toContain("ui-chat not found");
    expect(out.report).not.toContain("ui-theme not found");
    expect(out.report).not.toContain("ui-settings-general not found");
    expect(out.report).toContain("other plugin not found");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor reports missing binary and install hint", async () => {
  const { home, cfg } = await setup();
  try {
    const out = await doctor(cfg, async () => { throw new Error("ENOENT"); }, async () => ({ ok: true }));
    expect(out.ok).toBe(false);
    expect(out.report.toLowerCase()).toContain("install");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor creates a missing profile using only supported help", async () => {
  const { home, cfg } = await setup();
  try {
    await rm(join(home, "profiles/acp"), { recursive: true });
    const calls: string[][] = [];
    const out = await doctor(cfg, async cmd => { calls.push(cmd); return cmd.includes("--version") ? result("v1") : cmd.includes("--help") ? result("help") : result(fixture); }, async () => ({ ok: true }));
    expect(calls).toContainEqual(["fake-dsh", "--profile", "acp", "--help"]);
    expect(out.report.toLowerCase()).toContain("creat");
    expect(out.ok).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("failed profile setup and version commands fail without exposing their output", async () => {
  const { home, cfg } = await setup();
  try {
    const badVersion = await doctor(cfg, async () => result("secret-value", "secret-value", 8), async () => ({ ok: true }));
    expect(badVersion.ok).toBe(false);
    expect(badVersion.report).toContain("exit 8");
    expect(badVersion.report).not.toContain("secret-value");
    await rm(join(home, "profiles/acp"), { recursive: true });
    const badHelp = await doctor(cfg, async cmd => cmd.includes("--version") ? result("v1") : cmd.includes("--help") ? result("secret-value", "secret-value", 7) : result(fixture), async () => ({ ok: true }));
    expect(badHelp.ok).toBe(false);
    expect(badHelp.report).toContain("exit 7");
    expect(badHelp.report).not.toContain("secret-value");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("malformed or failed dump and failed initialize fail publicly without leaking dump contents", async () => {
  const { home, cfg } = await setup();
  try {
    for (const dump of [result("[broken: [secret-value"), result("secret-value", "secret-value", 1), result("{}"), result(""), result("- id: incomplete")]) {
      const out = await doctor(cfg, async cmd => cmd.includes("--version") ? result("v1") : dump, async () => ({ ok: true }));
      expect(out.ok).toBe(false);
      expect(out.report.toLowerCase()).toContain("dump");
      expect(out.report).not.toContain("secret-value");
    }
    const out = await doctor(cfg, async cmd => cmd.includes("--version") ? result("v1") : result(fixture), async () => ({ ok: false, error: "probe failed" }));
    expect(out.ok).toBe(false);
    expect(out.report).toContain("probe failed");
  } finally { await rm(home, { recursive: true, force: true }); }
});

const approvalRows = (defaultPreset: string) => [
  { id: "approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'" } },
  { id: "permission", name: "@deepseek-ai/dsh-permission-presets", config: { presets: { "workspace-write": { sandbox: "workspace-write", approval: "ask" }, "danger-full-access": { sandbox: "danger-full-access", approval: "ask" } }, defaultPreset } },
];
const runWith = (rows: unknown[], version = "0.2.1-rc.5") => async (cmd: string[]) => cmd.includes("--version") ? result(version) : result(JSON.stringify(rows));

test("doctor warns when the default preset is danger-full-access or the approval policy is never", async () => {
  const { home, cfg } = await setup();
  try {
    const safe = await doctor(cfg, runWith([...JSON.parse(fixture), ...approvalRows("workspace-write")]), async () => ({ ok: true }), {});
    expect(safe.report).toContain("default permission preset: workspace-write (sandbox workspace-write, approval ask)");
    expect(safe.report).toContain("DSH_PERMISSION_MODE: (unset, dsh uses workspace-write)");
    expect(safe.report).toContain("approval policy: ask");
    expect(safe.report).not.toContain("warning: permissions");

    const full = await doctor(cfg, runWith([...JSON.parse(fixture), ...approvalRows("danger-full-access")]), async () => ({ ok: true }), {});
    expect(full.ok).toBe(true);
    expect(full.report).toContain("warning: permissions: default preset is danger-full-access");

    const never = await doctor(cfg, runWith([...JSON.parse(fixture), ...approvalRows("workspace-write")]), async () => ({ ok: true }), { DSH_PERMISSION_MODE: "danger-full-access" });
    expect(never.report).toContain("approval policy: never");
    expect(never.report).toContain("warning: permissions: approval policy is never");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor fails when an enabled serverName equals dsh_agents_lead and warns on duplicate enabled names", async () => {
  const { home, cfg } = await setup();
  try {
    const base = JSON.parse(fixture);
    base[base.findIndex((r: { id: string }) => r.id === "mcp-outline")].config.toolCallTimeoutMs = 120000;
    const disabledDup = [...base, { id: "outline-disabled", name: "@deepseek-ai/dsh-mcp-client", disabled: true, config: { serverName: "outline" } }];
    const ok = await doctor(cfg, runWith(disabledDup), async () => ({ ok: true }), {});
    expect(ok.ok).toBe(true);
    expect(ok.report).toContain("mcp-outline: outline (timeout 120000 ms)");
    expect(ok.report).toContain("mcp-slack: slack (timeout default)");
    expect(ok.report).toContain("outline-disabled: outline (disabled)");
    expect(ok.report).not.toContain("duplicate");

    const dup = await doctor(cfg, runWith([...base, { id: "outline-2", config: { serverName: "outline" } }]), async () => ({ ok: true }), {});
    expect(dup.ok).toBe(true);
    expect(dup.report).toContain("warning: duplicate enabled MCP serverName outline: mcp-outline, outline-2");

    const clash = await doctor(cfg, runWith([...base, { id: "user-lead", config: { serverName: "dsh_agents_lead" } }]), async () => ({ ok: true }), {});
    expect(clash.ok).toBe(false);
    expect(clash.report).toContain("MCP row user-lead uses reserved serverName dsh_agents_lead");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("doctor warns when the dsh version differs from TESTED_DSH_VERSION", async () => {
  const { home, cfg } = await setup();
  try {
    const same = await doctor(cfg, runWith(JSON.parse(fixture), "0.2.1-rc.5"), async () => ({ ok: true }), {});
    expect(same.report).not.toContain("warning: dsh version");
    const other = await doctor(cfg, runWith(JSON.parse(fixture), "dsh 0.3.0"), async () => ({ ok: true }), {});
    expect(other.ok).toBe(true);
    expect(other.report).toContain("warning: dsh version 0.3.0 differs from tested 0.2.1-rc.5");
  } finally { await rm(home, { recursive: true, force: true }); }
});
