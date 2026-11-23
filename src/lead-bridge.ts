import { LEAD_SERVER_NAME } from "./config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeClient } from "./bridge/client";
import type { RequestFrame } from "./bridge/frames";

export async function runLeadBridge(args: string[]): Promise<number> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--socket" && flag !== "--token") || flags.has(flag)
      || !value || value.startsWith("--")) {
      console.error("usage: dsh-agents lead-bridge --socket <path> --token <token>");
      return 2;
    }
    flags.set(flag, value);
  }
  const path = flags.get("--socket");
  const token = flags.get("--token");
  if (!path || !token) {
    console.error("usage: dsh-agents lead-bridge --socket <path> --token <token>");
    return 2;
  }

  const bridge = new BridgeClient();
  const server = new McpServer({ name: LEAD_SERVER_NAME, version: "0.1.0" });
  const transport = new StdioServerTransport();
  const text = z.string().refine((value) => value.trim().length > 0, "must not be blank");
  const forward = async (tool: RequestFrame["tool"], input: Record<string, unknown>, signal: AbortSignal) => {
    // Socket failures belong to tool calls, not MCP startup or tools/list.
    await bridge.connect(path, token);
    const result = await bridge.call(tool, input, signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
  server.registerTool("ask_lead", {
    inputSchema: { question: text, choices: z.array(text).min(1).optional() },
  }, (input, extra) => forward("ask_lead", input, extra.signal));
  server.registerTool("wait_lead", {
    inputSchema: { questionId: text },
  }, (input, extra) => forward("wait_lead", input, extra.signal));
  server.registerTool("notify_lead", {
    inputSchema: { text },
  }, (input, extra) => forward("notify_lead", input, extra.signal));

  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  let stopping = false;
  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    bridge.close();
    void server.close().then(() => finish(code), () => {
      console.error("lead MCP shutdown failed");
      finish(1);
    });
  };
  const eof = () => shutdown();
  const stdinError = () => shutdown(1);
  server.server.onclose = eof;
  server.server.onerror = () => console.error("lead MCP transport error");
  // The SDK transport does not close itself on stdin EOF. The CLI exits when this promise settles.
  process.stdin.once("end", eof);
  process.stdin.once("close", eof);
  process.stdin.once("error", stdinError);
  try {
    await server.connect(transport);
    return await done;
  } catch {
    console.error("lead MCP startup failed");
    shutdown(1);
    return await done;
  } finally {
    process.stdin.removeListener("end", eof);
    process.stdin.removeListener("close", eof);
    process.stdin.removeListener("error", stdinError);
  }
}
