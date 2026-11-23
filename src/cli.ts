export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "mcp": {
      const { runMcp } = await import("./mcp/main.ts");
      return await runMcp(args);
    }
    case "lead-bridge": {
      const { runLeadBridge } = await import("./lead-bridge.ts");
      return await runLeadBridge(args);
    }
    case "doctor": {
      if (args.length) { console.error("usage: dsh-agents doctor"); return 2; }
      try {
        const [{ doctor, runCommand, initializeAcp }, { loadConfig }, { existsSync }] = await Promise.all([
          import("./doctor.ts"), import("./config.ts"), import("node:fs"),
        ]);
        const cfg = loadConfig(process.env, existsSync);
        const result = await doctor(cfg, runCommand, () => initializeAcp(cfg));
        console.log(result.report);
        return result.ok ? 0 : 1;
      } catch {
        console.error("doctor failed to load configuration");
        return 1;
      }
    }
    default:
      console.error("usage: dsh-agents <mcp|lead-bridge|doctor>");
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
