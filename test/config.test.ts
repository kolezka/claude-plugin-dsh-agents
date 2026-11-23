import { expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config";

const missing = () => false;

test("defaults use the web overlay when it exists", () => {
  const config = loadConfig(
    { HOME: "/h" },
    (path) => path === "/h/.dsh/profiles/web/cordis.patch.yml",
  );
  expect(config).toEqual({
    dshBin: "dsh",
    profile: "acp",
    patches: ["/h/.dsh/profiles/web/cordis.patch.yml"],
    model: undefined,
    reasoningEffort: undefined,
    permissions: "ask",
    bridgeWaitSeconds: 45,
    sessionIdleMinutes: 30,
    childIdleMinutes: 30,
    dshHome: "/h/.dsh",
    stateDir: "/h/.dsh/state/dsh-agents",
    socketDir: `/tmp/dsha-${process.getuid!()}`,
  });
});

test("omits the default overlay when it is missing", () => {
  expect(loadConfig({ HOME: "/h" }, missing).patches).toEqual([]);
});

test("environment overrides configure all fields", () => {
  const config = loadConfig({
    HOME: "/h",
    DSH_HOME: "/d",
    DSH_AGENTS_DSH_BIN: "/bin/custom-dsh",
    DSH_AGENTS_PROFILE: "custom",
    DSH_AGENTS_PATCH: "/a.yml:/b.yml",
    DSH_AGENTS_MODEL: "model",
    DSH_AGENTS_REASONING: "high",
    DSH_AGENTS_PERMISSIONS: "allow",
    DSH_AGENTS_BRIDGE_WAIT_SECONDS: "59",
    DSH_AGENTS_SESSION_IDLE_MINUTES: "15",
    DSH_AGENTS_CHILD_IDLE_MINUTES: "20",
    XDG_RUNTIME_DIR: "/run/u",
    TMPDIR: "/other",
  }, missing);
  expect(config).toEqual({
    dshBin: "/bin/custom-dsh",
    profile: "custom",
    patches: ["/a.yml", "/b.yml"],
    model: "model",
    reasoningEffort: "high",
    permissions: "allow",
    bridgeWaitSeconds: 59,
    sessionIdleMinutes: 15,
    childIdleMinutes: 20,
    dshHome: "/d",
    stateDir: "/d/state/dsh-agents",
    socketDir: "/run/u/dsha",
  });
});

test("default overlay follows DSH_HOME", () => {
  expect(loadConfig(
    { HOME: "/h", DSH_HOME: "/d" },
    (path) => path === "/d/profiles/web/cordis.patch.yml",
  ).patches).toEqual(["/d/profiles/web/cordis.patch.yml"]);
});

test("an explicit empty patch disables the default overlay", () => {
  expect(loadConfig({ HOME: "/h", DSH_AGENTS_PATCH: "" }, () => true).patches).toEqual([]);
});

test("socket dir falls back to TMPDIR with uid", () => {
  expect(loadConfig({ HOME: "/h", TMPDIR: "/temp" }, missing).socketDir)
    .toBe(`/temp/dsha-${process.getuid!()}`);
});

test.each(["60", "61", "1000"])("rejects bridge wait %s at or above 60", (value) => {
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_BRIDGE_WAIT_SECONDS: value }, missing))
    .toThrow(ConfigError);
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_BRIDGE_WAIT_SECONDS: value }, missing))
    .toThrow("DSH_AGENTS_BRIDGE_WAIT_SECONDS");
});

test("permissions accepts only ask or allow", () => {
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_PERMISSIONS: "yolo" }, missing))
    .toThrow(ConfigError);
  expect(() => loadConfig({ HOME: "/h", DSH_AGENTS_PERMISSIONS: "yolo" }, missing))
    .toThrow("DSH_AGENTS_PERMISSIONS");
});

for (const variable of [
  "DSH_AGENTS_BRIDGE_WAIT_SECONDS",
  "DSH_AGENTS_SESSION_IDLE_MINUTES",
  "DSH_AGENTS_CHILD_IDLE_MINUTES",
]) {
  test.each(["", " ", "0", "-1", "1.5", "12junk", " 12", "12 ", "NaN"])(
    `${variable} rejects invalid positive integer %j`,
    (value) => {
      const load = () => loadConfig({ HOME: "/h", [variable]: value }, missing);
      expect(load).toThrow(ConfigError);
      expect(load).toThrow(variable);
    },
  );
}
