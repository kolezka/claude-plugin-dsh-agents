import { createConnection, type Socket } from "node:net";
import { encodeFrame, FrameDecoder, type ReplyFrame, type RequestFrame } from "./frames";

export class LeadUnreachable extends Error {
  constructor() {
    super("lead is unreachable");
    this.name = "LeadUnreachable";
  }
}

type Call = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

function parseReply(value: unknown): ReplyFrame {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const frame = value as Record<string, unknown>;
    if (Object.keys(frame).length === 2 && typeof frame.id === "string" && frame.id.length > 0) {
      if (Object.hasOwn(frame, "result")) return { id: frame.id, result: frame.result };
      if (typeof frame.error === "string") return { id: frame.id, error: frame.error };
    }
  }
  throw new Error("invalid bridge reply");
}

export class BridgeClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private stopped = false;
  private calls = new Map<string, Call>();

  connect(path: string, token: string): Promise<void> {
    if (this.stopped) return Promise.reject(new LeadUnreachable());
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    const attempt = this.open(path, token);
    this.connecting = attempt;
    const settled = () => { if (this.connecting === attempt) this.connecting = undefined; };
    void attempt.then(settled, settled);
    return attempt;
  }

  call(tool: RequestFrame["tool"], args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Call aborted", "AbortError"));
    const socket = this.socket;
    if (!socket || socket.destroyed || this.connecting) return Promise.reject(new LeadUnreachable());
    const id = crypto.randomUUID();
    let payload: Uint8Array;
    try { payload = encodeFrame({ id, tool, args }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        if (!this.calls.delete(id)) return;
        cleanup();
        reject(signal?.reason ?? new DOMException("Call aborted", "AbortError"));
        try { socket.write(encodeFrame({ id, cancel: true })); }
        catch { this.disconnect(socket, new LeadUnreachable()); }
      };
      this.calls.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { socket.write(payload); }
      catch { this.disconnect(socket, new LeadUnreachable()); }
    });
  }

  close(): void {
    this.stopped = true;
    if (this.socket) this.disconnect(this.socket, new LeadUnreachable());
  }

  private open(path: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try { socket = createConnection(path); }
      catch { reject(new LeadUnreachable()); return; }
      this.socket = socket;
      const decoder = new FrameDecoder();
      const fail = (error: Error) => {
        reject(error);
        this.disconnect(socket, error);
      };
      socket.once("connect", () => {
        if (socket.destroyed) return;
        try { socket.write(encodeFrame({ hello: 1, token })); resolve(); }
        catch { fail(new LeadUnreachable()); }
      });
      socket.on("data", (chunk: Buffer) => {
        try {
          for (const value of decoder.push(chunk)) {
            const reply = parseReply(value);
            const call = this.calls.get(reply.id);
            // A cancelled call can still have a reply in flight.
            if (!call) continue;
            this.calls.delete(reply.id);
            call.cleanup();
            if ("error" in reply) call.reject(new Error(reply.error));
            else call.resolve(reply.result);
          }
        } catch { fail(new Error("invalid bridge reply (protocol error)")); }
      });
      socket.on("error", () => fail(new LeadUnreachable()));
      socket.on("end", () => fail(new LeadUnreachable()));
      socket.on("close", () => fail(new LeadUnreachable()));
    });
  }

  private disconnect(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const call of this.calls.values()) {
      call.cleanup();
      call.reject(error);
    }
    this.calls.clear();
    socket.destroy();
  }
}
