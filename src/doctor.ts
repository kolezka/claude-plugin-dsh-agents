import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LEAD_SERVER_NAME, TESTED_DSH_VERSION, type Config } from "./config";
import { redactDiagnostic } from "./acp/child";

type CommandResult = { code: number; stdout: string; stderr: string };
type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const safe = (text: string) => redactDiagnostic(text).replace(/https?:\/\/\S+/gi, "<URL>");
const expectedWarning = (line: string) => /\b(?:ui-settings-general|ui-chat|ui-theme)\b.*\bnot found\b/.test(line);

export async function doctor(cfg: Config, run: (cmd: string[]) => Promise<CommandResult>, acpInitialize: () => Promise<{ ok: boolean; error?: string }>, env: Record<string, string | undefined> = process.env): Promise<{ report: string; ok: boolean }> {
  const lines = [`dsh path: ${Bun.which(cfg.dshBin) ?? cfg.dshBin}`, `profile: ${cfg.profile}`, `overlays: ${cfg.patches.length ? cfg.patches.join(", ") : "none"}`, `effective config: ${JSON.stringify(cfg)}`];
  let ok = true;
  const fail = (message: string) => { ok = false; lines.push(message); };
  let version: CommandResult;
  try { version = await run([cfg.dshBin, "--version"]); }
  catch { fail("dsh binary unavailable. Install dsh and check DSH_AGENTS_DSH_BIN."); return { report: lines.join("\n"), ok }; }
  if (version.code !== 0 || !version.stdout.trim()) {
    fail(`dsh version failed (exit ${version.code}). Install or repair dsh.`);
    return { report: lines.join("\n"), ok };
  }
  const versionLine = safe(version.stdout.trim().split(/\r?\n/)[0]!);
  lines.push(`dsh version: ${versionLine}`);
  const found = versionLine.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0];
  if (found !== TESTED_DSH_VERSION) lines.push(`warning: dsh version ${found ?? versionLine} differs from tested ${TESTED_DSH_VERSION}`);
  const profilePath = join(cfg.dshHome, "profiles", cfg.profile);
  if (existsSync(profilePath)) lines.push(`profile present: ${profilePath}`);
  else {
    try {
      const help = await run([cfg.dshBin, "--profile", cfg.profile, "--help"]);
      if (help.code === 0) lines.push(`profile created via --help: ${profilePath}`);
      else fail(`profile creation failed (exit ${help.code})`);
    } catch { fail("profile creation failed: could not run dsh --help"); }
  }
  let dump: CommandResult | undefined;
  try { dump = await run([cfg.dshBin, "--profile", cfg.profile, "--dump-config", ...cfg.patches.flatMap(path => ["--patch", path])]); }
  catch { fail("dump-config failed: could not run dsh"); }
  if (dump && dump.code !== 0) fail(`dump-config failed (exit ${dump.code})`);
  if (dump && dump.code === 0) {
    for (const line of dump.stderr.split(/\r?\n/).filter(line => line.trim() && !expectedWarning(line))) lines.push(`warning: ${safe(line)}`);
    try {
      const parsed = Bun.YAML.parse(dump.stdout);
      if (!Array.isArray(parsed) || !parsed.length || parsed.some(row => !object(row) || typeof row.id !== "string" || (typeof row.name !== "string" && !object(row.config)))) throw new Error("invalid dump");
      const rows = parsed as Row[];
      const mcp = rows.flatMap(row => {
        const config = object(row.config);
        if (typeof config?.serverName !== "string") return [];
        const timeout = typeof config.toolCallTimeoutMs === "number" ? config.toolCallTimeoutMs : undefined;
        return [{ id: row.id as string, serverName: config.serverName, timeout, disabled: row.disabled === true }];
      });
      lines.push(`MCP rows found: ${mcp.length}`);
      for (const row of mcp) lines.push(`  ${row.id}: ${row.serverName} (${row.disabled ? "disabled" : `timeout ${row.timeout === undefined ? "default" : `${row.timeout} ms`}`})`);
      const enabled = mcp.filter(row => !row.disabled);
      for (const row of enabled.filter(row => row.serverName === LEAD_SERVER_NAME)) fail(`MCP row ${row.id} uses reserved serverName ${LEAD_SERVER_NAME}; rename it, dsh would reject the lead-bridge`);
      const byName = Map.groupBy(enabled, row => row.serverName);
      for (const [name, group] of byName) if (group.length > 1) lines.push(`warning: duplicate enabled MCP serverName ${name}: ${group.map(row => row.id).join(", ")}`);
      const presets = rows.find(row => row.name === "@deepseek-ai/dsh-permission-presets");
      const presetConfig = object(presets?.config);
      if (typeof presetConfig?.defaultPreset === "string") {
        const preset = object(object(presetConfig.presets)?.[presetConfig.defaultPreset]);
        lines.push(`default permission preset: ${presetConfig.defaultPreset} (sandbox ${String(preset?.sandbox ?? "?")}, approval ${String(preset?.approval ?? "?")})`);
        if (presetConfig.defaultPreset === "danger-full-access") lines.push("warning: permissions: default preset is danger-full-access; dsh will raise few or no permission requests for the lead to answer");
      }
      const mode = env.DSH_PERMISSION_MODE;
      lines.push(`DSH_PERMISSION_MODE: ${mode ?? "(unset, dsh uses workspace-write)"}`);
      const approval = object(rows.find(row => row.name === "@deepseek-ai/dsh-user-approval")?.config);
      if (approval) {
        // dsh evaluates this row's policy in the child it spawns, which inherits this environment.
        const policy = typeof approval.policy !== "string" || approval.policy === "ask" || approval.policy === "never"
          ? String(approval.policy ?? "ask")
          : /DSH_PERMISSION_MODE[\s\S]*danger-full-access[\s\S]*'never'/.test(approval.policy) ? ((mode ?? "workspace-write") === "danger-full-access" ? "never" : "ask") : "(expression, not evaluated)";
        lines.push(`approval policy: ${policy}`);
        if (policy === "never") lines.push("warning: permissions: approval policy is never; dsh rejects or allows by policy without asking the lead");
      }
      const providerRows = rows.flatMap(row => { const providers = object(object(row.config)?.providers); return providers ? Object.entries(providers) : []; });
      lines.push(`providers found: ${providerRows.length}`);
      for (const [provider, value] of providerRows) {
        const models = object(value)?.models;
        const names = Array.isArray(models) ? models.flatMap(model => typeof model === "string" ? [model] : typeof object(model)?.id === "string" ? [object(model)!.id as string] : []) : [];
        lines.push(`  ${provider}: ${names.join(", ") || "(no models listed)"}`);
      }
      const route = rows.find(row => row.id === "acp");
      const config = object(route?.config);
      lines.push(`acp default route: ${typeof config?.provider === "string" ? config.provider : "(unset)"} / ${typeof config?.model === "string" ? config.model : "(unset)"}`);
    } catch { fail("dump-config unreadable or malformed"); }
  }
  try {
    const probe = await acpInitialize();
    if (probe.ok) lines.push("ACP initialize: ok");
    else fail(`ACP initialize failed${probe.error ? `: ${safe(probe.error)}` : ""}`);
  } catch { fail("ACP initialize failed"); }
  return { report: lines.join("\n"), ok };
}

export async function runCommand(cmd: string[]): Promise<CommandResult> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

export async function initializeAcp(cfg: Config): Promise<{ ok: boolean; error?: string }> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let connection: ReturnType<ClientApp["connect"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([cfg.dshBin, "--profile", cfg.profile, ...cfg.patches.flatMap(path => ["--patch", path])], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void new Response(child.stderr).arrayBuffer();
    const proc = child;
    const output = new WritableStream<Uint8Array>({ write: async bytes => { proc.stdin.write(bytes); await proc.stdin.flush(); }, close: () => { proc.stdin.end(); }, abort: () => { proc.stdin.end(); } });
    connection = new ClientApp().connect(ndJsonStream(output, child.stdout));
    const conn = connection;
    void child.exited.then(() => conn.close());
    await Promise.race([
      connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "dsh-agents-doctor", version: "0.1.0" } }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 10000); }),
    ]);
    return { ok: true };
  } catch { return { ok: false, error: "could not initialize ACP (startup, transport, or timeout)" }; }
  finally {
    if (timer) clearTimeout(timer);
    connection?.close();
    if (child) {
      child.stdin.end();
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
      if (!exited) { child.kill("SIGKILL"); await child.exited; }
    }
  }
}
