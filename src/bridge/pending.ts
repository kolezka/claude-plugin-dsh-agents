export type PendingItem =
  | { requestId: string; kind: "question"; session: string; question: string; choices?: string[]; createdAt: number }
  | { requestId: string; kind: "permission"; session: string; toolCallId: string; options: Array<{ optionId: string; kind: string; name: string }>; context?: { title?: string; kind?: string; rawInput?: unknown } | "missing"; createdAt: number };
export type PermissionItem = Extract<PendingItem, { kind: "permission" }>;
export type Answer = { text: string } | { choice: string } | { cancelled: true };

export class PendingError extends Error {
  constructor(readonly code: "unknown" | "answered" | "invalid" | "waiting") { super(code); }
}

type Waiter = { deliver: (answer: Answer) => void; reject: (error: Error) => void };
type Entry = { item: PendingItem; answer?: Answer; waiter?: Waiter };

export class PendingQueue {
  private entries = new Map<string, Entry>();
  private answered = new Map<string, string>();
  private listeners = new Set<(session: string) => void>();

  addQuestion(session: string, question: string, choices?: string[]): PendingItem {
    return this.add({ requestId: crypto.randomUUID(), kind: "question", session, question, choices, createdAt: Date.now() });
  }

  addPermission(
    session: string, toolCallId: string, options: PermissionItem["options"], context: PermissionItem["context"],
  ): PendingItem {
    return this.add({ requestId: crypto.randomUUID(), kind: "permission", session, toolCallId, options, context, createdAt: Date.now() });
  }

  list(session: string): PendingItem[] {
    return [...this.entries.values()]
      .filter((entry) => entry.item.session === session && entry.answer === undefined)
      .map((entry) => structuredClone(entry.item));
  }

  answer(requestId: string, answer: Answer): void {
    if (this.answered.has(requestId)) throw new PendingError("answered");
    const entry = this.entries.get(requestId);
    if (!entry) throw new PendingError("unknown");
    if (!this.validAnswer(entry.item, answer)) throw new PendingError("invalid");
    entry.answer = structuredClone(answer);
    this.answered.set(requestId, entry.item.session);
    if (entry.waiter) {
      this.entries.delete(requestId);
      entry.waiter.deliver(entry.answer);
    }
    this.changed(entry.item.session);
  }

  waitFor(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer | "timeout"> {
    if (signal?.aborted) return Promise.reject(new DOMException("Wait aborted", "AbortError"));
    const entry = this.entries.get(requestId);
    if (!entry) return Promise.reject(new PendingError("unknown"));
    if (entry.waiter) return Promise.reject(new PendingError("waiting"));
    if (entry.answer !== undefined) {
      this.entries.delete(requestId);
      return Promise.resolve(entry.answer);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        entry.waiter = undefined;
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Wait aborted", "AbortError"));
      };
      const timer = setTimeout(() => { cleanup(); resolve("timeout"); }, timeoutMs);
      entry.waiter = {
        deliver: (answer) => { cleanup(); resolve(answer); },
        reject: (error) => { cleanup(); reject(error); },
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  // Check ownership before consuming even a buffered answer, which list() omits.
  waitForQuestion(session: string, requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer | "timeout"> {
    const entry = this.entries.get(requestId);
    if (entry?.item.kind !== "question" || entry.item.session !== session) {
      return Promise.reject(new PendingError("unknown"));
    }
    return this.waitFor(requestId, timeoutMs, signal);
  }

  cancelSession(session: string): void {
    for (const [requestId, entry] of this.entries) {
      if (entry.item.session === session && entry.answer === undefined) {
        this.answer(requestId, { cancelled: true });
      }
    }
  }

  invalidateSession(session: string): void {
    for (const [requestId, entry] of this.entries) {
      if (entry.item.session !== session) continue;
      this.entries.delete(requestId);
      entry.waiter?.reject(new PendingError("unknown"));
    }
    for (const [requestId, owner] of this.answered) {
      if (owner === session) this.answered.delete(requestId);
    }
    this.changed(session);
  }

  onChange(listener: (session: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private add(item: PendingItem): PendingItem {
    this.entries.set(item.requestId, { item: structuredClone(item) });
    this.changed(item.session);
    return structuredClone(item);
  }

  private changed(session: string) {
    for (const listener of this.listeners) listener(session);
  }

  private validAnswer(item: PendingItem, answer: Answer): boolean {
    if (answer === null || typeof answer !== "object" || Object.keys(answer).length !== 1) return false;
    if ("cancelled" in answer) return answer.cancelled === true;
    if (item.kind === "permission") {
      return "choice" in answer && typeof answer.choice === "string"
        && item.options.some((option) => option.optionId === answer.choice);
    }
    // Question choices are hints, not permission option IDs.
    return "text" in answer && typeof answer.text === "string";
  }
}
