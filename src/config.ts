import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dshBin: string;
  profile: string;
  patches: string[];
  model?: string;
  reasoningEffort?: string;
  permissions: "ask" | "allow";
  bridgeWaitSeconds: number;
  sessionIdleMinutes: number;
  childIdleMinutes: number;
  dshHome: string;
  stateDir: string;
  socketDir: string;
}

/** dsh release this plugin is built and tested against; doctor warns on any other. */
export const TESTED_DSH_VERSION = "0.2.1-rc.5";
/** Name of the per-session lead-bridge MCP server. dsh reserves `lead` as its root agent name and rejects duplicate server names, so it is namespaced. */
export const LEAD_SERVER_NAME = "dsh_agents_lead";

export class ConfigError extends Error {}

export function loadConfig(
  env: Record<string, string | undefined>,
  fsExists: (p: string) => boolean,
): Config {
  const positiveInteger = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive integer`);
    }
    return value;
  };

  const dshHome = env.DSH_HOME ?? join(env.HOME ?? homedir(), ".dsh");
  const defaultPatch = join(dshHome, "profiles", "web", "cordis.patch.yml");
  const patches = env.DSH_AGENTS_PATCH === undefined
    ? (fsExists(defaultPatch) ? [defaultPatch] : [])
    : (env.DSH_AGENTS_PATCH === "" ? [] : env.DSH_AGENTS_PATCH.split(":"));
  const permissions = env.DSH_AGENTS_PERMISSIONS ?? "ask";
  if (permissions !== "ask" && permissions !== "allow") {
    throw new ConfigError("DSH_AGENTS_PERMISSIONS must be ask or allow");
  }
  const bridgeWaitSeconds = positiveInteger("DSH_AGENTS_BRIDGE_WAIT_SECONDS", 45);
  if (bridgeWaitSeconds >= 60) {
    throw new ConfigError("DSH_AGENTS_BRIDGE_WAIT_SECONDS must be less than 60");
  }

  return {
    dshBin: env.DSH_AGENTS_DSH_BIN ?? "dsh",
    profile: env.DSH_AGENTS_PROFILE ?? "acp",
    patches,
    model: env.DSH_AGENTS_MODEL,
    reasoningEffort: env.DSH_AGENTS_REASONING,
    permissions,
    bridgeWaitSeconds,
    sessionIdleMinutes: positiveInteger("DSH_AGENTS_SESSION_IDLE_MINUTES", 30),
    childIdleMinutes: positiveInteger("DSH_AGENTS_CHILD_IDLE_MINUTES", 30),
    dshHome,
    stateDir: join(dshHome, "state", "dsh-agents"),
    socketDir: env.XDG_RUNTIME_DIR
      ? join(env.XDG_RUNTIME_DIR, "dsha")
      : join(env.TMPDIR || "/tmp", `dsha-${process.getuid!()}`),
  };
}
