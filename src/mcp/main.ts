import { existsSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config";
import { Journal } from "../journal";
import { PendingQueue } from "../bridge/pending";
import { BridgeSocketServer } from "../bridge/socket";
import { DshAcpClient } from "../acp/client";
import { DshChild, redactDiagnostic } from "../acp/child";
import { createDshMcpServer } from "./server";

export function installStdoutGuard() {
  const original = process.stdout.write;
  const send = original.bind(process.stdout);
  const protocolOutput = new Writable({ write(chunk, encoding, callback) { send(chunk, encoding, callback); } });
  const log = console.log;
  const info = console.info;
  const debug = console.debug;
  console.log = console.info = console.debug = console.error.bind(console);
  process.stdout.write = ((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") queueMicrotask(() => callback());
    return true;
  }) as typeof process.stdout.write;
  return { protocolOutput, restore() { process.stdout.write = original; console.log = log; console.info = info; console.debug = debug; } };
}

export async function runMcp(args: string[] = []): Promise<number> {
  const guard = installStdoutGuard();
  let client: DshAcpClient | undefined;
  let bridge: BridgeSocketServer | undefined;
  let server: ReturnType<typeof createDshMcpServer> | undefined;
  let transport: StdioServerTransport | undefined;
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });
  const log = (message: string) => console.error(redactDiagnostic(message));
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      // Each owner is cleaned even when a prior cleanup failed.
      for (const [name, close] of [
        ["ACP client", () => client?.shutdown()],
        ["bridge socket", () => bridge?.close()],
        ["MCP server", () => server?.close()],
        ["MCP transport", () => transport?.close()],
      ] as const) {
        try { await close(); }
        catch (error) { code = 1; log(`${name} shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      finish(code);
    })();
  };
  const eof = () => stop();
  const failed = (error: Error) => { log(`MCP stdin failed: ${error.message}`); stop(1); };
  process.stdin.once("end", eof);
  process.stdin.once("close", eof);
  process.stdin.once("error", failed);
  process.once("SIGTERM", eof);
  try {
    if (args.length) { log("usage: dsh-agents mcp"); stop(2); }
    else {
      const cfg = loadConfig(process.env, existsSync);
      const journal = new Journal(join(cfg.stateDir, "sessions"));
      const pending = new PendingQueue();
      bridge = new BridgeSocketServer({ socketDir: cfg.socketDir, pending, bridgeWaitMs: cfg.bridgeWaitSeconds * 1000, onNote: (session, text) => client!.recordNote(session, text), log });
      client = new DshAcpClient({ cfg, journal, pending, bridge, spawnChild: () => new DshChild(cfg, log) });
      server = createDshMcpServer(client, journal);
      transport = new StdioServerTransport(process.stdin, guard.protocolOutput);
      server.server.onclose = eof;
      server.server.onerror = error => log(`MCP transport error: ${error.message}`);
      await server.connect(transport);
      if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    }
  } catch (error) {
    log(`MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
    stop(1);
  }
  try { return await done; }
  finally {
    process.stdin.removeListener("end", eof);
    process.stdin.removeListener("close", eof);
    process.stdin.removeListener("error", failed);
    process.removeListener("SIGTERM", eof);
    guard.restore();
    guard.protocolOutput.destroy();
  }
}
