import { ClientApp, type ClientConnection, type SessionConfigOption, type SessionInfo, type RequestPermissionRequest, type RequestPermissionResponse, type SessionUpdate, type McpServer } from "@agentclientprotocol/sdk";
import { resolve } from "node:path";
import type { Config } from "../config";
import { Journal, type JournalRecord } from "../journal";
import { PendingQueue, type PendingItem, type Answer } from "../bridge/pending";
import type { BridgeSocketServer } from "../bridge/socket";
import { DshChild, redactDiagnostic } from "./child";
import { toFollowEvents } from "./events";

export type RunStatus = "submitted" | "running" | "waiting" | "final" | "cancelled" | "error" | "unknown";
export class PromptInFlight extends Error {
  constructor(public runId: string, public waiting: boolean) { super(`Prompt ${runId} is still in flight`); this.name = "PromptInFlight"; }
}
export class CwdMismatch extends Error { override name = "CwdMismatch"; }
export class BusyElsewhere extends Error { override name = "BusyElsewhere"; }
export class UnknownRequest extends Error { override name = "UnknownRequest"; }
export class ModelNotAvailable extends Error {
  constructor(public options: unknown, message = "Requested model or reasoning effort is not available") { super(message); this.name = "ModelNotAvailable"; }
}

class OperationTimeout extends Error { constructor() { super("ACP operation timed out"); } }
type Deps = { cfg: Config; journal: Journal; pending: PendingQueue; bridge: BridgeSocketServer; spawnChild: () => DshChild; now?: () => number };
type Transport = { child: DshChild; generation: number; connection?: ClientConnection; ready: boolean; failed: boolean; retiring?: Promise<void> };
type Run = { id: string; cancelling: boolean; settling?: Promise<void>; written: { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } };
type Session = { id: string; cwd: string; live: boolean; owner: Transport; closing: boolean; closeTask?: Promise<void>; pendingCancellation?: Promise<void>; lastUsed: number; title?: string; updatedAt?: string; options: SessionConfigOption[] | null; run?: Run; tools: Map<string, Extract<SessionUpdate, { sessionUpdate: "tool_call" }>>; io: Promise<void>; ioError?: unknown; questions: Set<string> };

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OperationTimeout()), Math.max(1, ms)); })]); }
  finally { clearTimeout(timer!); }
}

export class DshAcpClient {
  private registry = new Map<string, Session>();
  private locks = new Map<string, Promise<void>>();
  private transport?: Transport;
  private connecting?: Promise<ClientConnection>;
  private operations = new Set<Promise<unknown>>();
  private owners = new WeakMap<ClientConnection, Transport>();
  private diagnostics = new WeakSet<Error>();
  private resolutions = new WeakMap<Session, Map<string, Promise<void>>>();
  private lastCatalog: SessionConfigOption[] | null = null;
  private generation = 0;
  private stopping = false;
  private stopped?: Promise<void>;
  private lastChildUse: number;
  private timer: ReturnType<typeof setInterval>;
  private reaping = false;
  private lifecycleError?: unknown;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.lastChildUse = this.now();
    this.unsubscribe = deps.pending.onChange(session => {
      const state = this.registry.get(session);
      if (state?.run) {
        for (const item of deps.pending.list(session)) {
          if (item.kind !== "question" || state.questions.has(item.requestId)) continue;
          state.questions.add(item.requestId);
          void this.append(state, { t: "question", runId: state.run.id, requestId: item.requestId, question: item.question, at: this.now() });
        }
      }
      this.changed();
    });
    this.timer = setInterval(() => { void this.idle(); }, 100);
    this.timer.unref();
  }

  private changed() { for (const listener of this.listeners) listener(); }
  private assertOpen() { if (this.stopping) throw new Error("ACP client is shutting down"); }

  private operate<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    this.operations.add(operation);
    return operation.then(value => { this.lastChildUse = this.now(); return value; }).finally(() => this.operations.delete(operation));
  }

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const completion = result.then(() => {}, () => {});
    this.locks.set(key, completion);
    try { return await result; }
    finally { if (this.locks.get(key) === completion) this.locks.delete(key); }
  }

  private append(state: Session, record: JournalRecord): Promise<void> {
    const operation = state.io.then(async () => {
      if (state.ioError) throw state.ioError;
      await this.deps.journal.append(state.id, record);
      this.changed();
    });
    state.io = operation.catch(error => { state.ioError = error; this.changed(); });
    // Notification callbacks cannot reject into an unobserved promise.
    void operation.catch(() => {});
    return operation;
  }

  private diagnostic(owner: Transport, error: unknown): Error {
    if (error instanceof Error && this.diagnostics.has(error)) return error;
    const message = redactDiagnostic(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    const tail = owner.child.lastStderrLines(10).join("\n").slice(-8192);
    // Shutdown distinguishes close deadlines from actual lifecycle failures.
    const result = error instanceof OperationTimeout ? new OperationTimeout() : new Error();
    result.message = tail ? `${message}\ndsh stderr:\n${tail}` : message;
    this.diagnostics.add(result);
    return result;
  }

  private retire(owner: Transport): Promise<void> {
    return owner.retiring ??= (async () => {
      try { await owner.child.shutdown(); }
      finally { owner.connection?.close(); }
      if (this.transport === owner) this.transport = undefined;
    })();
  }

  private transportClosed(owner: Transport) {
    owner.failed = true;
    const error = this.diagnostic(owner, new Error("ACP transport closed"));
    for (const state of this.registry.values()) {
      if (state.owner !== owner || !state.live) continue;
      state.live = false;
      this.deps.bridge.releaseSession(state.id);
      if (state.run) {
        state.run.written.reject(error);
        void this.settle(state, state.run, "unknown", undefined, error.message);
      } else this.deps.pending.cancelSession(state.id);
    }
    // SDK transport closure does not reap the subprocess. Keep its owner until reap.
    void this.retire(owner).catch(error => { this.lifecycleError = error; this.changed(); });
    this.changed();
  }

  private async connect(): Promise<ClientConnection> {
    this.assertOpen();
    if (this.connecting) return this.connecting;
    const current = this.transport;
    if (current?.ready && !current.failed && !current.retiring && !current.connection!.signal.aborted) return current.connection!;
    const connecting = (async () => {
      if (current) await this.retire(current);
      this.assertOpen();
      const owner: Transport = { child: this.deps.spawnChild(), generation: ++this.generation, ready: false, failed: false };
      this.transport = owner;
      try {
        const { stream } = await owner.child.start();
        this.assertOpen();
        const app = new ClientApp();
        app.onNotification("session/update", async ({ params }) => {
          const state = this.registry.get(params.sessionId);
          if (!state || state.owner !== owner || !state.live) return;
          const update = params.update;
          if (update.sessionUpdate === "tool_call") state.tools.set(update.toolCallId, update);
          if (update.sessionUpdate === "config_option_update") state.options = update.configOptions;
          await this.append(state, { t: "update", runId: state.run?.id, update, at: this.now() });
        });
        app.onRequest("session/request_permission", ({ params }) => this.permission(params, owner));
        const writer = stream.writable.getWriter();
        const connection = app.connect({ ...stream, writable: new WritableStream({
          write: async message => {
            const session = "method" in message && message.method === "session/prompt" ? (message.params as { sessionId?: string })?.sessionId : undefined;
            const state = session ? this.registry.get(session) : undefined;
            const run = state?.owner === owner ? state.run : undefined;
            try { await writer.write(message); run?.written.resolve(); }
            catch (error) { run?.written.reject(this.diagnostic(owner, error)); throw error; }
          },
          close: () => writer.close(),
          abort: reason => writer.abort(reason),
        }) });
        owner.connection = connection;
        this.owners.set(connection, owner);
        void owner.child.exited.then(() => connection.close(this.diagnostic(owner, new Error("dsh child exited"))));
        void connection.closed.then(() => this.transportClosed(owner));
        await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "dsh-agents", version: "0.1.0" } });
        this.assertOpen();
        if (owner.failed || connection.signal.aborted) throw new Error("ACP connection closed during initialization");
        owner.ready = true;
        this.lastChildUse = this.now();
        return connection;
      } catch (error) {
        await this.retire(owner);
        throw this.diagnostic(owner, error);
      }
    })();
    this.connecting = connecting;
    try { return await connecting; }
    finally { if (this.connecting === connecting) this.connecting = undefined; }
  }

  private async permission(params: RequestPermissionRequest, owner: Transport): Promise<RequestPermissionResponse> {
    const state = this.registry.get(params.sessionId);
    if (!state?.run || !state.live || state.owner !== owner) return { outcome: { outcome: "cancelled" } };
    const run = state.run;
    const tool = state.tools.get(params.toolCall.toolCallId);
    const context = tool ? { title: tool.title, kind: tool.kind, rawInput: tool.rawInput } : "missing";
    const allowed = this.deps.cfg.permissions === "allow" ? params.options.find(o => o.kind === "allow_once" || o.kind === "allow_always") : undefined;
    if (this.stopping || state.closing || run.cancelling || run.settling) {
      const reject = params.options.find(o => o.kind === "reject_once" || o.kind === "reject_always");
      return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
    }
    const item = this.deps.pending.addPermission(state.id, params.toolCall.toolCallId, params.options, context);
    await this.append(state, { t: "permission", runId: run.id, requestId: item.requestId, toolCallId: params.toolCall.toolCallId, ...(allowed ? { auto: true } : {}), at: this.now() });
    if (allowed && this.deps.pending.list(state.id).some(p => p.requestId === item.requestId)) {
      await this.resolvePending(state, item.requestId, { choice: allowed.optionId });
    }
    try {
      let answer: Answer | "timeout";
      do { answer = await this.deps.pending.waitFor(item.requestId, 60_000); } while (answer === "timeout" && state.run === run && state.live);
      if (answer === "timeout" || "cancelled" in answer) {
        const reject = params.options.find(o => o.kind === "reject_once" || o.kind === "reject_always");
        return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
      }
      if (!("choice" in answer)) throw new Error("Permission received a non-choice answer");
      return { outcome: { outcome: "selected", optionId: answer.choice } };
    } catch (error) {
      if (!state.live || state.run !== run) return { outcome: { outcome: "cancelled" } };
      throw error;
    }
  }

  private async listed(connection: ClientConnection, cwd?: string): Promise<SessionInfo[]> {
    const owner = this.owners.get(connection)!;
    const result: SessionInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await connection.agent.request("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }).catch(error => { throw this.diagnostic(owner, error); });
      result.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
      if (cursor) { if (seen.has(cursor)) throw new Error("session/list repeated a cursor"); seen.add(cursor); }
    } while (cursor);
    return result;
  }

  async start(a: { task: string; session?: string; cwd?: string; model?: string; reasoningEffort?: string }): Promise<{ session: string; runId: string; status: "submitted" }> {
    this.assertOpen();
    return this.operate(() => this.locked(a.session ?? "new-session", async () => {
      this.assertOpen();
      let state = a.session ? this.registry.get(a.session) : undefined;
      if (state?.run) throw new PromptInFlight(state.run.id, this.deps.pending.list(state.id).length > 0);
      const connection = await this.connect(); this.assertOpen();
      const owner = this.owners.get(connection)!;
      if (state && a.cwd && resolve(a.cwd) !== resolve(state.cwd)) throw new CwdMismatch(`session cwd does not match: ${a.cwd}`);
      if (!state?.live) {
        const persisted = a.session ? (await this.listed(connection)).find(s => s.sessionId === a.session) : undefined;
        this.assertOpen();
        if (a.session && !persisted) throw new UnknownRequest(`Session ${a.session} is not resumable`);
        const cwd = a.cwd ?? persisted?.cwd ?? process.cwd();
        const socket = await this.deps.bridge.listen();
        this.assertOpen();
        const token = this.deps.bridge.allocateToken();
        const mcpServers: McpServer[] = [{ name: "lead", command: process.execPath, args: [resolve(import.meta.dir, "../cli.ts"), "lead-bridge", "--socket", socket, "--token", token], env: [] }];
        let id: string;
        let options: SessionConfigOption[] | null;
        try {
          if (a.session) {
            const response = await connection.agent.request("session/resume", { sessionId: a.session, cwd, mcpServers });
            id = a.session; options = response.configOptions ?? null;
          } else {
            const response = await connection.agent.request("session/new", { cwd, mcpServers });
            id = response.sessionId; options = response.configOptions ?? null;
          }
          if (connection.signal.aborted || owner.failed || owner.retiring) throw new Error("ACP connection closed during session setup");
          this.deps.bridge.releaseSession(id);
          this.deps.pending.invalidateSession(id);
          this.deps.bridge.bindToken(token, id);
        } catch (error) {
          this.deps.bridge.releaseToken(token);
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("session cwd does not match")) throw new CwdMismatch(this.diagnostic(owner, error).message);
          if (/busy|already.*(?:active|open|running)|locked/i.test(message)) throw new BusyElsewhere(this.diagnostic(owner, error).message);
          throw this.diagnostic(owner, error);
        }
        this.lastCatalog = structuredClone(options);
        state = { id, cwd: persisted?.cwd ?? cwd, live: true, owner, closing: this.stopping, lastUsed: this.now(), title: persisted?.title ?? undefined, updatedAt: persisted?.updatedAt ?? undefined, options, tools: new Map(), io: Promise.resolve(), questions: new Set() };
        this.registry.set(id, state);
        this.deps.bridge.setSessionClosing(id, this.stopping);
        if (a.session) await this.append(state, { t: "resumed", version: 1, at: this.now() });
      }
      this.assertOpen();
      await this.configure(connection, state, "model", a.model ?? this.deps.cfg.model);
      await this.configure(connection, state, "thought_level", a.reasoningEffort ?? this.deps.cfg.reasoningEffort);
      this.assertOpen();
      if (!state.live || owner.failed || owner.retiring) throw this.diagnostic(owner, new Error("ACP connection closed before prompt submission"));
      const run: Run = { id: crypto.randomUUID(), cancelling: false, written: Promise.withResolvers<void>() };
      void run.written.promise.catch(() => {});
      state.tools.clear(); state.questions.clear();
      await this.append(state, { t: "submitted", runId: run.id, task: a.task, at: this.now() });
      this.assertOpen();
      state.run = run; state.lastUsed = this.now(); this.lastChildUse = this.now();
      this.deps.bridge.setSessionClosing(state.id, false);
      if (state.options) await this.append(state, { t: "update", update: { sessionUpdate: "config_option_update", configOptions: state.options }, at: this.now() });
      this.assertOpen();
      const session = state;
      void connection.agent.request("session/prompt", { sessionId: state.id, prompt: [{ type: "text", text: a.task }] }).then(
        response => this.settle(session, run, response.stopReason === "end_turn" ? "final" : response.stopReason === "cancelled" ? "cancelled" : "error", response.stopReason, response.stopReason === "end_turn" || response.stopReason === "cancelled" ? undefined : `Agent stopped with ${response.stopReason}`),
        error => this.settle(session, run, connection.signal.aborted ? "unknown" : "error", undefined, this.diagnostic(owner, error).message),
      ).catch(error => { session.ioError = error; this.changed(); });
      await run.written.promise;
      return { session: state.id, runId: run.id, status: "submitted" };
    }));
  }

  private async configure(connection: ClientConnection, state: Session, category: string, value?: string) {
    if (value === undefined) return;
    const option = state.options?.find(o => o.category === category || o.id === (category === "thought_level" ? "reasoning_effort" : "model"));
    const values = option?.type === "select" ? option.options.flatMap(o => "group" in o ? o.options : [o]) : [];
    if (!option || !values.some(o => o.value === value)) throw new ModelNotAvailable(state.options);
    const owner = this.owners.get(connection)!;
    const response = await connection.agent.request("session/set_config_option", { sessionId: state.id, configId: option.id, value }).catch(error => { throw this.diagnostic(owner, error); });
    state.options = response.configOptions;
    if (state.options.find(o => o.id === option.id)?.currentValue !== value) throw new ModelNotAvailable(state.options, "Agent did not confirm the requested currentValue");
    await this.append(state, { t: "update", update: { sessionUpdate: "config_option_update", configOptions: state.options }, at: this.now() });
  }

  private settle(state: Session, run: Run, status: "final" | "cancelled" | "error" | "unknown", stopReason?: string, error?: string): Promise<void> {
    if (run.settling) return run.settling;
    this.deps.bridge.setSessionClosing(state.id, true);
    run.settling = (async () => {
      await this.cancelPending(state);
      await this.append(state, { t: "settled", runId: run.id, status, stopReason, error, at: this.now() });
      if (state.run === run) state.run = undefined;
      state.lastUsed = this.now(); this.lastChildUse = this.now(); this.changed();
    })();
    void run.settling.catch(error => { state.ioError = error; this.changed(); });
    return run.settling;
  }

  private resolvePending(state: Session, requestId: string, answer: Answer): Promise<void> {
    let resolutions = this.resolutions.get(state);
    if (!resolutions) { resolutions = new Map(); this.resolutions.set(state, resolutions); }
    const existing = resolutions.get(requestId);
    if (existing) return existing;
    // Claim the answer before journal I/O yields to cancellation or settlement.
    const resolution = Promise.resolve().then(async () => {
      await this.append(state, { t: "answer", requestId, answer, at: this.now() });
      this.deps.pending.answer(requestId, answer);
    });
    resolutions.set(requestId, resolution);
    return resolution;
  }

  private cancelPending(state: Session): Promise<void> {
    if (state.pendingCancellation) return state.pendingCancellation;
    const cancellation = (async () => {
      for (const item of this.deps.pending.list(state.id)) {
        await this.resolvePending(state, item.requestId, { cancelled: true });
      }
    })();
    state.pendingCancellation = cancellation;
    void cancellation.finally(() => { if (state.pendingCancellation === cancellation) state.pendingCancellation = undefined; }).catch(() => {});
    return cancellation;
  }

  async recordNote(session: string, text: string): Promise<void> {
    this.assertOpen();
    const state = this.registry.get(session);
    if (!state?.live || state.closing || state.run?.cancelling || state.run?.settling) throw new UnknownRequest(`Unknown or closing session ${session}`);
    // Queue now, before another ACP callback can settle or replace this run.
    const appended = this.append(state, { t: "note", runId: state.run?.id, text, at: this.now() });
    return this.operate(() => appended);
  }

  async follow(a: { session: string; runId: string; after: number; waitSeconds?: number }) {
    const end = Date.now() + Math.max(0, Math.min(300, a.waitSeconds ?? 90)) * 1000;
    while (true) {
      const state = this.registry.get(a.session);
      await state?.io;
      if (state?.ioError) throw state.ioError;
      const { records, next } = await this.deps.journal.read(a.session, 0);
      const index = records.findIndex(r => r.t === "submitted" && r.runId === a.runId);
      if (index < 0) throw new UnknownRequest(`Unknown run ${a.runId}`);
      if (records.slice(index + 1).some(r => r.t === "resumed")) throw new UnknownRequest("Run handle expired by session resume");
      const settled = records.slice(index + 1).find(r => r.t === "settled" && r.runId === a.runId);
      const active = state?.run?.id === a.runId;
      const pending = active && !settled ? this.deps.pending.list(a.session) : [];
      const updated = records.slice(index + 1).some(r => r.t === "update" && r.runId === a.runId);
      const status: RunStatus = settled?.t === "settled" ? settled.status : !active ? "unknown" : pending.length ? "waiting" : updated ? "running" : "submitted";
      const events = toFollowEvents(records.map((rec, i) => ({ seq: i + 1, rec })).filter(({ seq, rec }) => seq > a.after && ("runId" in rec ? rec.runId === a.runId : seq > index)));
      if (next > a.after || pending.length || !active || settled || Date.now() >= end) {
        return { status, events, pending, next, ...(["final", "cancelled", "error", "unknown"].includes(status) ? { reply: await this.deps.journal.reply(a.session, a.runId) } : {}), ...(settled?.t === "settled" && settled.error ? { error: settled.error } : {}) };
      }
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.listeners.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(250, Math.max(0, end - Date.now())));
        this.listeners.add(wake);
      });
    }
  }

  async answer(a: { session: string; requestId: string; text?: string; choice?: string }): Promise<void> {
    return this.operate(() => this.locked(a.session, async () => {
      const state = this.registry.get(a.session);
      const item = this.deps.pending.list(a.session).find(p => p.requestId === a.requestId);
      if (this.stopping || state?.closing || !state?.run || state.run.cancelling || state.run.settling || !item) throw new UnknownRequest(`Unknown or expired request ${a.requestId}`);
      let answer: Answer;
      if (item.kind === "question") {
        if (typeof a.text !== "string" || a.choice !== undefined) throw new Error("Question answers require text");
        answer = { text: a.text };
      } else {
        if (typeof a.choice !== "string" || a.text !== undefined || !item.options.some(o => o.optionId === a.choice)) throw new Error("Permission answers require an advertised choice");
        answer = { choice: a.choice };
      }
      if (this.resolutions.get(state)?.has(item.requestId)) throw new UnknownRequest(`Unknown or expired request ${a.requestId}`);
      await this.resolvePending(state, item.requestId, answer);
    }));
  }

  async cancel(session: string): Promise<void> {
    return this.operate(() => this.locked(session, async () => {
      const state = this.registry.get(session);
      if (!state?.run) return;
      state.run.cancelling = true;
      this.deps.bridge.setSessionClosing(session, true);
      await this.cancelPending(state);
      await Bun.sleep(0);
      if (state.live && state.owner.connection) await state.owner.connection.agent.notify("session/cancel", { sessionId: session }).catch(error => { throw this.diagnostic(state.owner, error); });
    }));
  }

  async sessions(a: { cwd?: string; limit?: number }): Promise<Array<{ session: string; cwd: string; liveHere: boolean; title?: string }>> {
    this.assertOpen();
    return this.operate(async () => {
      const connection = await this.connect();
      const owner = this.owners.get(connection)!;
      let infos: SessionInfo[];
      try { infos = await this.listed(connection, a.cwd); }
      catch (error) { throw this.diagnostic(owner, error); }
      const all = new Map(infos.map(info => [info.sessionId, { session: info.sessionId, cwd: info.cwd, title: info.title ?? undefined, updatedAt: info.updatedAt ?? "", liveHere: false }]));
      for (const state of this.registry.values()) {
        if (!state.live || a.cwd && a.cwd !== state.cwd) continue;
        const old = all.get(state.id);
        all.set(state.id, { session: state.id, cwd: state.cwd, title: old?.title ?? state.title, updatedAt: old?.updatedAt || new Date(state.lastUsed).toISOString(), liveHere: true });
      }
      return [...all.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, a.limit).map(({ updatedAt, ...info }) => info);
    });
  }

  async models(session?: string): Promise<{ configOptions: unknown; source: "live" | "cached" } | { configOptions: null; hint: string }> {
    const state = session ? this.registry.get(session) : undefined;
    if (state?.live && state.options) return { configOptions: structuredClone(state.options), source: "live" };
    if (this.lastCatalog) return { configOptions: structuredClone(this.lastCatalog), source: "cached" };
    return { configOptions: null, hint: "Start a session to inspect advertised model options." };
  }

  private markClosing(state: Session) {
    state.closing = true;
    this.deps.bridge.setSessionClosing(state.id, true);
  }

  private closeState(state: Session, until = Date.now() + 5000): Promise<void> {
    if (state.closeTask) return state.closeTask;
    this.markClosing(state);
    return state.closeTask = (async () => {
      try {
        await this.cancelPending(state);
        await Bun.sleep(0);
        const connection = state.owner.connection;
        if (state.live && connection && !connection.signal.aborted) {
          if (Date.now() >= until) throw this.diagnostic(state.owner, new OperationTimeout());
          try { await deadline(connection.agent.request("session/close", { sessionId: state.id }), Math.min(5000, until - Date.now())); }
          catch (error) {
            // Transport loss already invalidates the session; its owner still reaps the child.
            if (!connection.signal.aborted) throw this.diagnostic(state.owner, error);
          }
        }
      } finally {
        state.live = false; this.deps.bridge.releaseSession(state.id); this.deps.pending.invalidateSession(state.id);
        if (state.run) await this.settle(state, state.run, "unknown", undefined, "Session closed before prompt settlement");
        state.lastUsed = this.now(); this.lastChildUse = this.now();
      }
    })();
  }

  async close(session: string): Promise<void> {
    return this.operate(() => this.locked(session, async () => {
      const state = this.registry.get(session);
      if (state?.live) await this.closeState(state);
    }));
  }

  private idleEligible(state: Session) {
    return !this.stopping && state.live && !state.closing && !state.run && !this.deps.pending.list(state.id).length && this.now() - state.lastUsed >= this.deps.cfg.sessionIdleMinutes * 60_000;
  }

  private async idle() {
    if (this.stopping || this.reaping) return;
    this.reaping = true;
    try {
      for (const state of this.registry.values()) {
        if (!this.idleEligible(state)) continue;
        await this.locked(state.id, async () => {
          // A start ahead of this lock can make the earlier idle snapshot obsolete.
          if (this.registry.get(state.id) !== state || !this.idleEligible(state)) return;
          try { await this.closeState(state); }
          catch (error) {
            if (state.ioError) throw error;
            // A close RPC failure belongs to this session, not sibling journal pipelines.
            await this.append(state, { t: "note", text: `Idle session close failed: ${this.diagnostic(state.owner, error).message}`, at: this.now() });
          }
        });
      }
      const owner = this.transport;
      if (!this.stopping && owner && !this.connecting && !this.operations.size && ![...this.registry.values()].some(s => s.live || s.run) && this.now() - this.lastChildUse >= this.deps.cfg.childIdleMinutes * 60_000) await this.retire(owner);
    } catch (error) {
      this.lifecycleError = error;
      this.changed();
    } finally { this.reaping = false; }
  }

  shutdown(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true; clearInterval(this.timer);
    for (const state of this.registry.values()) this.markClosing(state);
    return this.stopped = (async () => {
      const until = Date.now() + 15_000;
      const failures: unknown[] = [];
      let timedOut = false;
      try {
        // Admission is closed before the global durable cancellation phase.
        await deadline(Promise.all([...this.registry.values()].map(state => this.cancelPending(state))), until - Date.now());
        await deadline(Promise.allSettled([...this.operations]), until - Date.now());
        for (const state of this.registry.values()) this.markClosing(state);
        await deadline(Promise.all([...this.registry.values()].map(state => this.cancelPending(state))), until - Date.now());
        const closes = [...this.registry.values()].filter(state => state.live).map(state => this.locked(state.id, () => this.closeState(state, until)));
        const results = await deadline(Promise.allSettled(closes), until - Date.now());
        for (const result of results) {
          if (result.status !== "rejected") continue;
          if (result.reason instanceof OperationTimeout) timedOut = true;
          else failures.push(result.reason);
        }
      } catch (error) {
        if (error instanceof OperationTimeout) timedOut = true;
        else failures.push(error);
      }
      try {
        if (timedOut) {
          await deadline(Promise.all([...this.registry.values()].map(state => this.append(state, { t: "note", text: "ACP shutdown operation deadline exceeded", at: this.now() }))), until - Date.now());
        }
        await deadline(Promise.all([...this.registry.values()].map(state => state.io)), until - Date.now());
        for (const state of this.registry.values()) if (state.ioError) failures.push(state.ioError);
      } catch (error) { failures.push(error); }
      try { if (this.transport) await this.retire(this.transport); }
      catch (error) { failures.push(error); }
      finally {
        for (const state of this.registry.values()) this.deps.pending.cancelSession(state.id);
        this.unsubscribe();
      }
      if (this.lifecycleError && !(this.lifecycleError instanceof OperationTimeout)) failures.push(this.lifecycleError);
      if (failures.length) throw new AggregateError(failures, "ACP shutdown failed");
    })();
  }
}
