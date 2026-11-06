export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "mcp":
      await import("./mcp/main.ts" as string);
      return 0;
    case "lead-bridge": {
      const { runLeadBridge } = await import("./lead-bridge.ts");
      return await runLeadBridge(args);
    }
    case "doctor":
      await import("./doctor.ts" as string);
      return 0;
    default:
      console.error("usage: dsh-agents <mcp|lead-bridge|doctor>");
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
