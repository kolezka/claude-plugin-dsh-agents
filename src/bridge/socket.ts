import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { ConfigError } from "../config";
import { encodeFrame, FrameDecoder, FrameShapeError, FrameTooLarge, parseInbound, type ReplyFrame, type RequestFrame } from "./frames";
import { PendingError, PendingQueue } from "./pending";

type Options = {
  socketDir: string;
  pending: PendingQueue;
  bridgeWaitMs: number;
  onNote: (session: string, text: string) => unknown;
  log: (line: string) => void;
};
type Token = { session?: string; closing?: boolean };
type Connection = {
  socket: Socket;
  token?: Token;
  closed: boolean;
  ids: Set<string>;
  waits: Map<string, AbortController>;
};

export class BridgeSocketServer {
  private tokens = new Map<string, Token>();
  private connections = new Set<Connection>();
  private server?: Server;
  private listening?: Promise<string>;
  private closing?: Promise<void>;
  private closed = false;
  private ownedPath?: string;

  constructor(private opts: Options) {}

  listen(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("bridge is closed"));
    if (!this.listening) this.listening = this.start();
    return this.listening;
  }

  allocateToken(): string {
    if (this.closed) throw new Error("bridge is closed");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.tokens.set(token, {});
    return token;
  }

  bindToken(token: string, session: string): void {
    const binding = this.tokens.get(token);
    if (!binding) throw new Error("unknown token");
    if (!session) throw new Error("session is required");
    if (binding.session !== undefined && binding.session !== session) throw new Error("token is already bound");
    binding.session = session;
    binding.closing = false;
  }

  releaseToken(token: string): void {
    const binding = this.tokens.get(token);
    if (!binding) return;
    this.tokens.delete(token);
    for (const connection of this.connections) {
      if (connection.token === binding) this.disconnect(connection);
    }
  }

  setSessionClosing(session: string, closing: boolean): void {
    for (const binding of this.tokens.values()) {
      if (binding.session === session) binding.closing = closing;
    }
  }

  releaseSession(session: string): void {
    for (const [token, binding] of this.tokens) {
      if (binding.session === session) this.tokens.delete(token);
    }
    for (const connection of this.connections) {
      if (connection.token?.session === session) this.disconnect(connection);
    }
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }

  private async start(): Promise<string> {
    const path = join(this.opts.socketDir, `s-${process.pid}.sock`);
    if (Buffer.byteLength(path) >= 104) throw new ConfigError("bridge socket path must be less than 104 bytes");
    await mkdir(this.opts.socketDir, { recursive: true, mode: 0o700 });
    await chmod(this.opts.socketDir, 0o700);
    await this.removeStale(path);
    if (this.closed) throw new Error("bridge is closed");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen(path, () => {
        server.removeListener("error", failed);
        server.on("error", () => this.opts.log("bridge listener error"));
        resolve();
      });
    });
    this.ownedPath = path;
    await chmod(path, 0o600);
    return path;
  }

  private async removeStale(path: string): Promise<void> {
    let existing;
    try { existing = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!existing.isSocket()) throw new Error("bridge path exists and is not a socket");
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(path);
      const timer = setTimeout(() => {
        probe.destroy();
        reject(new Error("bridge socket probe timed out"));
      }, 1000);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(true);
        else reject(error);
      });
    });
    if (!stale) throw new Error("bridge socket is active");
    // Do not remove a replacement that appeared while the probe was in flight.
    let current;
    try { current = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!current.isSocket() || current.ino !== existing.ino || current.dev !== existing.dev) {
      throw new Error("bridge socket changed during probe");
    }
    await unlink(path);
  }

  private accept(socket: Socket) {
    const connection: Connection = { socket, closed: false, ids: new Set(), waits: new Map() };
    this.connections.add(connection);
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (connection.closed) break;
          const frame = parseInbound(value);
          if ("hello" in frame) {
            if (connection.token) { this.disconnect(connection, "repeated hello"); break; }
            const token = this.tokens.get(frame.token);
            if (!token) { this.disconnect(connection, "invalid authentication token"); break; }
            connection.token = token;
          } else if (!connection.token) {
            this.disconnect(connection, "authentication required");
          } else if ("cancel" in frame) {
            connection.waits.get(frame.id)?.abort();
          } else {
            void this.request(connection, frame);
          }
        }
      } catch (error) {
        const reason = error instanceof FrameShapeError ? "invalid frame shape"
          : error instanceof FrameTooLarge ? "frame exceeds byte limit" : "invalid frame JSON or UTF-8";
        this.disconnect(connection, reason);
      }
    });
    socket.on("end", () => this.disconnect(connection));
    socket.on("close", () => this.disconnect(connection));
    socket.on("error", () => this.disconnect(connection, "socket error"));
  }

  private async request(connection: Connection, frame: RequestFrame): Promise<void> {
    if (connection.ids.has(frame.id)) {
      this.reply(connection, { id: frame.id, error: "duplicate request id" });
      return;
    }
    connection.ids.add(frame.id);
    const session = connection.token?.session;
    if (session === undefined) {
      this.reply(connection, { id: frame.id, error: "token is not bound" });
      return;
    }
    if (connection.token?.closing) {
      this.reply(connection, frame.tool === "notify_lead"
        ? { id: frame.id, error: "session is closing" }
        : { id: frame.id, result: { status: "cancelled" } });
      return;
    }
    const controller = new AbortController();
    connection.waits.set(frame.id, controller);
    try {
      const args = frame.args;
      if (frame.tool === "notify_lead") {
        if (!this.text(args.text)) throw new Error("invalid arguments");
        await this.opts.onNote(session, args.text);
        this.reply(connection, { id: frame.id, result: { ok: true } });
        return;
      }
      let questionId: string;
      if (frame.tool === "ask_lead") {
        if (!this.text(args.question) || (args.choices !== undefined
          && (!Array.isArray(args.choices) || args.choices.length === 0 || !args.choices.every((choice) => this.text(choice))))) {
          throw new Error("invalid arguments");
        }
        const item = this.opts.pending.addQuestion(session, args.question, args.choices as string[] | undefined);
        questionId = item.requestId;
      } else {
        if (!this.text(args.questionId)) throw new Error("invalid arguments");
        questionId = args.questionId;
      }
      const answer = await this.opts.pending.waitForQuestion(session, questionId, this.opts.bridgeWaitMs, controller.signal);
      const result = answer === "timeout"
        ? { status: "pending", questionId, hint: "Call wait_lead with questionId to keep waiting." }
        : "cancelled" in answer ? { status: "cancelled" } : { status: "answered", answer };
      // Consumption is at-most-once, not an acknowledgement that the peer read the reply.
      this.reply(connection, { id: frame.id, result });
    } catch (error) {
      if (controller.signal.aborted) this.reply(connection, { id: frame.id, result: { status: "cancelled" } });
      else this.reply(connection, { id: frame.id, error: error instanceof PendingError ? error.code : "invalid arguments or request failed" });
    } finally {
      connection.waits.delete(frame.id);
    }
  }

  private text(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  private reply(connection: Connection, reply: ReplyFrame) {
    if (connection.closed || connection.socket.destroyed) return;
    try { connection.socket.write(encodeFrame(reply)); }
    catch { this.disconnect(connection, "reply encoding or write failed"); }
  }

  private disconnect(connection: Connection, reason?: string) {
    if (connection.closed) return;
    connection.closed = true;
    if (reason) this.opts.log(`bridge connection closed: ${reason}`);
    for (const wait of connection.waits.values()) wait.abort();
    connection.waits.clear();
    this.connections.delete(connection);
    connection.socket.destroy();
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.tokens.clear();
    // A concurrent listen must settle before its listener can be closed.
    if (this.listening) {
      try { await this.listening; }
      catch { this.opts.log("bridge listen did not complete"); }
    }
    for (const connection of this.connections) this.disconnect(connection);
    if (this.server?.listening) {
      await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    }
    if (this.ownedPath) {
      try { await unlink(this.ownedPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.ownedPath = undefined;
    }
  }
}
