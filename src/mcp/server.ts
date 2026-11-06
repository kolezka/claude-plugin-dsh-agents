import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DshAcpClient } from "../acp/client";
import type { Journal } from "../journal";

type Client = Pick<DshAcpClient, "start" | "follow" | "answer" | "cancel" | "sessions" | "models" | "close">;
const text = z.string().refine(value => value.trim().length > 0, "must not be blank");
const startShape = { task: text, session: text.optional(), cwd: text.optional(), model: text.optional(), reasoningEffort: text.optional() };
const sessionShape = { session: text };
const limit = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional();

function result(structuredContent: Record<string, unknown>, isError = false) {
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], ...(isError ? { isError: true } : {}) };
}

function errorResult(error: unknown, context: Record<string, unknown> = {}) {
  return result({ ...context, error: error instanceof Error ? { ...error, name: error.name, message: error.message } : { name: "Error", message: String(error) } }, true);
}

async function handled(work: () => Promise<Record<string, unknown>>) {
  try { return result(await work()); }
  catch (error) { return errorResult(error); }
}

async function ask(client: Client, args: Parameters<Client["start"]>[0] & { timeoutSeconds: number }, signal: AbortSignal) {
  const { timeoutSeconds, ...input } = args;
  const run = await client.start(input);
  const end = Date.now() + timeoutSeconds * 1000;
  type Follow = Awaited<ReturnType<Client["follow"]>>;
  let latest: Follow = { status: run.status, next: 0, events: [], pending: [] };
  const events: Follow["events"] = [];
  const expired = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout>;
  let aborted!: () => void;
  const stop = new Promise<typeof expired>((resolve, reject) => {
    timer = setTimeout(() => resolve(expired), Math.max(0, end - Date.now()));
    aborted = () => reject(new Error(`MCP request cancelled; dsh run ${run.runId} in session ${run.session} remains active`));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  // A detached ACP poll must still have its rejection observed after timeout.
  void stop.catch(() => {});
  try {
    while (Date.now() < end) {
      const after = latest.next;
      const update = await Promise.race([client.follow({ session: run.session, runId: run.runId, after, waitSeconds: Math.min(300, (end - Date.now()) / 1000) }), stop]);
      if (update === expired) break;
      latest = update;
      events.push(...update.events);
      if (update.pending.length || ["final", "cancelled", "error", "unknown"].includes(update.status)) {
        return result({ ...run, ...update, events, status: update.pending.length ? "waiting" : update.status });
      }
      if (latest.next === after || !update.events.length) {
        if (await Promise.race([Bun.sleep(Math.min(50, Math.max(0, end - Date.now()))), stop]) === expired) break;
      }
    }
    return result({ ...run, ...latest, events, timedOut: true });
  } catch (error) {
    // Observation failed, not the submitted task. Keep its handle for recovery.
    return errorResult(error, {
      ...run, ...latest, events, status: "unknown",
      recovery: "Current run fate is unknown. Retain session/runId and recover via follow/history; journal repair may be needed. Do not resend automatically.",
    });
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", aborted);
  }
}

export function createDshMcpServer(client: Client, journal: Journal): McpServer {
  const server = new McpServer({ name: "dsh", version: "0.1.0" });
  server.registerTool("start", { description: "Submit one dsh task. Lazily starts the ACP child; reuse a session to continue it.", inputSchema: startShape }, args => handled(() => client.start(args)));
  server.registerTool("follow", {
    description: "Read durable run events and pending requests after a journal cursor.",
    inputSchema: { ...sessionShape, runId: text, after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), waitSeconds: z.number().min(0).max(300).default(90) },
  }, args => handled(() => client.follow(args)));
  server.registerTool("answer", {
    description: "Answer exactly one pending question with text, or a permission with its advertised opaque choice ID.",
    inputSchema: z.object({ ...sessionShape, requestId: text, text: z.string().optional(), choice: text.optional() }).refine(args => (args.text !== undefined) !== (args.choice !== undefined), "Exactly one of text or choice is required"),
  }, args => handled(async () => {
    if ((args.text !== undefined) === (args.choice !== undefined)) throw new Error("Exactly one of text or choice is required");
    await client.answer(args); return { ok: true };
  }));
  server.registerTool("ask", {
    description: "Start once, then follow until pending input, termination or timeout. Timeout and MCP cancellation never cancel the dsh task.",
    inputSchema: { ...startShape, timeoutSeconds: z.number().positive().max(3600).default(600) },
  }, (args, extra) => ask(client, args, extra.signal).catch(error => errorResult(error)));
  server.registerTool("cancel", { description: "Request cancellation of the active run in this session.", inputSchema: sessionShape }, args => handled(async () => { await client.cancel(args.session); return { ok: true }; }));
  server.registerTool("sessions", { description: "List resumable and live sessions. Lazily starts the ACP child.", inputSchema: { cwd: text.optional(), limit } }, async args => handled(async () => ({ sessions: await client.sessions(args) })));
  server.registerTool("history", { description: "Read this plugin's local journal, not complete dsh history. Does not start dsh.", inputSchema: { ...sessionShape, limit } }, args => handled(async () => ({ source: "dsh-agents journal", history: await journal.history(args.session, args.limit) })));
  server.registerTool("models", { description: "Inspect live or cached model options without creating a discovery session.", inputSchema: { session: text.optional() } }, args => handled(() => client.models(args.session)));
  server.registerTool("close", { description: "Close this client's live session and its pending requests.", inputSchema: sessionShape }, args => handled(async () => { await client.close(args.session); return { ok: true }; }));
  return server;
}
