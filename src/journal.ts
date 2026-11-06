import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type JournalRecord =
  | { t: "submitted"; runId: string; task: string; at: number }
  | { t: "update"; runId?: string; update: unknown; at: number }
  | { t: "permission"; runId?: string; requestId: string; toolCallId: string; auto?: boolean; at: number }
  | { t: "question"; runId?: string; requestId: string; question: string; at: number }
  | { t: "answer"; requestId: string; answer: unknown; at: number }
  | { t: "note"; runId?: string; text: string; at: number }
  | { t: "settled"; runId: string; status: "final" | "cancelled" | "error" | "unknown"; stopReason?: string; error?: string; at: number };

type HistoryEntry = { role: "user" | "lead" | "assistant"; text: string; at: number };

export class JournalReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JournalReadError";
  }
}

const pendingAppends = new Map<string, Promise<void>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is JournalRecord {
  if (!isObject(value) || typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  const str = (key: string) => typeof value[key] === "string";
  const optionalString = (key: string) => value[key] === undefined || str(key);
  switch (value.t) {
    case "submitted": return str("runId") && str("task");
    case "update": return optionalString("runId") && Object.hasOwn(value, "update");
    case "permission": return optionalString("runId") && str("requestId") && str("toolCallId")
      && (value.auto === undefined || typeof value.auto === "boolean");
    case "question": return optionalString("runId") && str("requestId") && str("question");
    case "answer": return str("requestId") && Object.hasOwn(value, "answer");
    case "note": return optionalString("runId") && str("text");
    case "settled": return str("runId") && ["final", "cancelled", "error", "unknown"].includes(value.status as string)
      && optionalString("stopReason") && optionalString("error");
    default: return false;
  }
}

function messageText(update: unknown): string | undefined {
  if (!isObject(update) || update.sessionUpdate !== "agent_message_chunk" || !isObject(update.content)) return;
  if (update.content.type === "text" && typeof update.content.text === "string") return update.content.text;
}

function answerText(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (isObject(answer)) {
    if (typeof answer.text === "string") return answer.text;
    if (typeof answer.choice === "string") return answer.choice;
  }
  return JSON.stringify(answer);
}

export class Journal {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private path(session: string): string {
    if (!session || session === "." || session === ".." || /[/\\\0]/.test(session)) {
      throw new Error("Invalid journal session identifier");
    }
    return join(this.dir, `${session}.jsonl`);
  }

  private async records(path: string): Promise<JournalRecord[]> {
    let text: string;
    try {
      const data = await Bun.file(path).arrayBuffer();
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return [];
      throw new JournalReadError(`Cannot read journal ${path}`, { cause: error });
    }
    if (!text) return [];
    if (!text.endsWith("\n")) throw new JournalReadError(`Incomplete journal ${path}`);
    return text.slice(0, -1).split("\n").map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new JournalReadError(`Invalid journal JSON at ${path}:${index + 1}`, { cause: error });
      }
      if (!isRecord(value)) throw new JournalReadError(`Invalid journal record at ${path}:${index + 1}`);
      return value;
    });
  }

  async append(session: string, rec: JournalRecord): Promise<number> {
    const path = this.path(session);
    const previous = pendingAppends.get(path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const records = await this.records(path);
      const line = JSON.stringify(rec);
      if (line === undefined || !isRecord(JSON.parse(line))) throw new Error("Invalid journal record");
      await appendFile(path, line + "\n", { mode: 0o600 });
      return records.length + 1;
    });
    const completion = operation.then(() => {}, () => {});
    pendingAppends.set(path, completion);
    try {
      return await operation;
    } finally {
      if (pendingAppends.get(path) === completion) pendingAppends.delete(path);
    }
  }

  async read(session: string, after: number): Promise<{ records: JournalRecord[]; next: number }> {
    const records = await this.records(this.path(session));
    return { records: records.slice(Math.max(0, after)), next: records.length };
  }

  async reply(session: string, runId: string): Promise<string> {
    const { records } = await this.read(session, 0);
    let active = false;
    let result = "";
    for (const record of records) {
      if (record.t === "submitted" && record.runId === runId) active = true;
      else if (record.t === "settled" && record.runId === runId) active = false;
      else if (active && record.t === "update" && record.runId === runId) result += messageText(record.update) ?? "";
    }
    return result;
  }

  async history(session: string, limit?: number): Promise<HistoryEntry[]> {
    const { records } = await this.read(session, 0);
    const result: HistoryEntry[] = [];
    const active = new Map<string, HistoryEntry | undefined>();
    for (const record of records) {
      if (record.t === "submitted") {
        result.push({ role: "user", text: record.task, at: record.at });
        active.set(record.runId, undefined);
      } else if (record.t === "settled") {
        active.delete(record.runId);
      } else if (record.t === "answer") {
        result.push({ role: "lead", text: answerText(record.answer), at: record.at });
      } else if (record.t === "update" && record.runId !== undefined && active.has(record.runId)) {
        const text = messageText(record.update);
        if (text === undefined) continue;
        let entry = active.get(record.runId);
        if (!entry || result[result.length - 1] !== entry) {
          entry = { role: "assistant", text: "", at: record.at };
          active.set(record.runId, entry);
          result.push(entry);
        }
        entry.text += text;
      }
    }
    return limit === undefined ? result : result.slice(-Math.max(0, limit) || result.length);
  }
}
