import type { JournalRecord } from "../journal";

export type FollowEvent = { seq: number; kind: "text" | "thought" | "tool_call" | "tool_result" | "config" | "usage" | "note"; text?: string; toolCallId?: string; title?: string; status?: string; detail?: unknown };

export function toFollowEvents(records: Array<{ seq: number; rec: JournalRecord }>): FollowEvent[] {
  return records.flatMap(({ seq, rec }): FollowEvent[] => {
    if (rec.t === "note") return [{ seq, kind: "note", text: rec.text }];
    if (rec.t !== "update") return [];
    const update = rec.update as Record<string, any> | null;
    if (!update || typeof update !== "object") return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": return [{ seq, kind: update.sessionUpdate === "agent_message_chunk" ? "text" : "thought", ...(update.content?.type === "text" ? { text: update.content.text } : { detail: update.content }) }];
      case "tool_call": return [{ seq, kind: "tool_call", toolCallId: update.toolCallId, title: update.title, status: update.status, detail: update }];
      case "tool_call_update": return [{ seq, kind: "tool_result", toolCallId: update.toolCallId, title: update.title, status: update.status, detail: update }];
      case "config_option_update": return [{ seq, kind: "config", detail: update.configOptions }];
      case "usage_update": return [{ seq, kind: "usage", detail: update }];
      default: return [{ seq, kind: "note", detail: update }];
    }
  });
}
