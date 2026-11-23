import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Journal, JournalReadError, type JournalRecord } from "../src/journal";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp("/tmp/dsh-journal-");
  roots.push(root);
  const dir = join(root, "sessions");
  return { root, dir, journal: new Journal(dir) };
}

const submitted: JournalRecord = { t: "submitted", runId: "r1", task: "Build it", at: 1 };
const chunk = (runId: string | undefined, text: string, at: number): JournalRecord => ({
  t: "update", runId, at,
  update: { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text } },
});
const settled: JournalRecord = { t: "settled", runId: "r1", status: "final", at: 5 };

test("append returns cursors and read returns only later records", async () => {
  const { journal } = await fixture();
  expect(await journal.append("s1", submitted)).toBe(1);
  expect(await journal.append("s1", settled)).toBe(2);
  expect(await journal.read("s1", 1)).toEqual({ records: [settled], next: 2 });
  expect(await journal.read("s1", 20)).toEqual({ records: [], next: 2 });
});

test("creates the session directory and file with private modes", async () => {
  const { journal, dir } = await fixture();
  await journal.append("session-1", submitted);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, "session-1.jsonl"))).mode & 0o777).toBe(0o600);
});

test("concurrent appends across instances have distinct persistent cursors", async () => {
  const { journal, dir } = await fixture();
  const other = new Journal(dir);
  const cursors = await Promise.all(Array.from({ length: 40 }, (_, at) =>
    (at % 2 ? journal : other).append("s1", { t: "note", text: `n${at}`, at })));
  expect([...cursors].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  const fresh = new Journal(dir);
  const read = await fresh.read("s1", 0);
  expect(read.next).toBe(40);
  expect(new Set(read.records.map((record) => record.t === "note" && record.text)).size).toBe(40);
  expect(await fresh.append("s1", settled)).toBe(41);
  expect(await journal.read("s1", 40)).toEqual({ records: [settled], next: 41 });
});

test("reply includes only assistant text in the selected run boundaries", async () => {
  const { journal } = await fixture();
  const records: JournalRecord[] = [
    chunk("r1", "before", 0), submitted, chunk("r1", "Hello ", 2),
    { t: "update", runId: "r1", at: 3, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } } },
    chunk("r2", "other", 3),
    { t: "update", runId: "r1", at: 3, update: { sessionUpdate: "agent_message_chunk", messageId: "img", content: { type: "image", data: "AA==", mimeType: "image/png" } } },
    chunk("r1", "world", 4), settled, chunk("r1", "after", 6),
  ];
  for (const record of records) await journal.append("s1", record);
  expect(await journal.reply("s1", "r1")).toBe("Hello world");
  expect(await journal.reply("s1", "r2")).toBe("");
  expect((await journal.read("s1", 0)).records).toEqual(records);
});

test("history lists user tasks, lead answers and assistant replies in record order", async () => {
  const { journal } = await fixture();
  const records: JournalRecord[] = [
    submitted,
    { t: "question", runId: "r1", requestId: "q1", question: "Which?", at: 2 },
    { t: "answer", requestId: "q1", answer: { text: "this one" }, at: 3 },
    chunk("r1", "Done", 4), settled,
    { t: "submitted", runId: "r2", task: "Again", at: 6 },
    chunk("r2", "Yes", 7),
    { t: "settled", runId: "r2", status: "final", at: 8 },
  ];
  for (const record of records) await journal.append("s1", record);
  const expected: Array<{ role: "user" | "lead" | "assistant"; text: string; at: number }> = [
    { role: "user", text: "Build it", at: 1 },
    { role: "lead", text: "this one", at: 3 },
    { role: "assistant", text: "Done", at: 4 },
    { role: "user", text: "Again", at: 6 },
    { role: "assistant", text: "Yes", at: 7 },
  ];
  expect(await journal.history("s1")).toEqual(expected);
  expect(await journal.history("s1", 2)).toEqual(expected.slice(-2));
  expect(await journal.history("s1", 0)).toEqual([]);
});

test("history keeps lead answers between assistant chunks in journal order", async () => {
  const { journal } = await fixture();
  for (const record of [
    submitted,
    chunk("r1", "Before", 2),
    { t: "answer", requestId: "q1", answer: { text: "answer" }, at: 3 } as JournalRecord,
    chunk("r1", "After", 4),
    settled,
  ]) await journal.append("s1", record);
  expect(await journal.history("s1")).toEqual([
    { role: "user", text: "Build it", at: 1 },
    { role: "assistant", text: "Before", at: 2 },
    { role: "lead", text: "answer", at: 3 },
    { role: "assistant", text: "After", at: 4 },
  ]);
});

test("all valid record envelopes survive a file round trip", async () => {
  const { journal, dir } = await fixture();
  const records: JournalRecord[] = [
    submitted,
    { t: "update", update: null, at: 2 },
    { t: "permission", runId: "r1", requestId: "p1", toolCallId: "t1", auto: false, at: 3 },
    { t: "question", requestId: "q1", question: "What?", at: 4 },
    { t: "answer", requestId: "q1", answer: null, at: 5 },
    { t: "note", text: "note", at: 6 },
    { t: "settled", runId: "r1", status: "error", stopReason: "other", error: "message", at: 7 },
  ];
  for (const record of records) await journal.append("s1", record);
  expect(await new Journal(dir).read("s1", 0))
    .toEqual({ records, next: 7 });
});

test("unknown sessions are empty", async () => {
  const { journal } = await fixture();
  expect(await journal.read("missing", 10)).toEqual({ records: [], next: 0 });
  expect(await journal.reply("missing", "r1")).toBe("");
  expect(await journal.history("missing")).toEqual([]);
});

test.each(["", ".", "..", "../outside", "a/b", "/absolute", "a\\b", "bad\0name"]) (
  "rejects unsafe session identifier %j", async (session) => {
    const { journal } = await fixture();
    await expect(journal.append(session, submitted)).rejects.toThrow(/^Invalid journal session identifier/);
    await expect(journal.read(session, 0)).rejects.toThrow(/^Invalid journal session identifier/);
    await expect(journal.reply(session, "r1")).rejects.toThrow(/^Invalid journal session identifier/);
    await expect(journal.history(session)).rejects.toThrow(/^Invalid journal session identifier/);
  },
);

test("accepts ordinary session identifiers verbatim", async () => {
  const { journal } = await fixture();
  for (const session of ["s1", "uuid-123_abc", "with space", "żółw"]) {
    await journal.append(session, submitted);
    expect(await journal.read(session, 0)).toEqual({ records: [submitted], next: 1 });
  }
});

const goodLines = [submitted, chunk("r1", "OK", 2), settled].map((record) => JSON.stringify(record)).join("\n") + "\n";
const invalidLines = [
  ["invalid JSON", "{bad}\n", "Invalid journal JSON"],
  ["truncated JSON", '{"t":"submitted"', "Invalid journal JSON"],
  ["valid JSON without line terminator", JSON.stringify(submitted), "Invalid journal JSON"],
  ["null envelope", "null\n", "Invalid journal record"],
  ["unknown record kind", '{"t":"future","at":1}\n', "Invalid journal record"],
  ["missing timestamp", '{"t":"note","text":"x"}\n', "Invalid journal record"],
  ["bad optional run id", '{"t":"note","text":"x","at":1,"runId":42}\n', "Invalid journal record"],
  ["missing update", '{"t":"update","at":1}\n', "Invalid journal record"],
  ["missing answer", '{"t":"answer","requestId":"q","at":1}\n', "Invalid journal record"],
  ["bad permission", '{"t":"permission","requestId":"q","toolCallId":"t","auto":"yes","at":1}\n', "Invalid journal record"],
  ["bad question", '{"t":"question","requestId":"q","question":3,"at":1}\n', "Invalid journal record"],
  ["bad settled status", '{"t":"settled","runId":"r1","status":"done","at":1}\n', "Invalid journal record"],
  ["bad settled metadata", '{"t":"settled","runId":"r1","status":"final","error":42,"at":1}\n', "Invalid journal record"],
  ["blank line", "\n", "Invalid journal JSON"],
];

async function expectJournalReadError(operation: Promise<unknown>, diagnostic: string) {
  await expect(operation).rejects.toBeInstanceOf(JournalReadError);
  await expect(operation).rejects.toThrow(new RegExp(`^${diagnostic}`));
}

test.each(invalidLines)("read, reply and history reject %s even before a valid tail", async (_label, invalid, diagnostic) => {
  const { dir, journal } = await fixture();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Bun.write(join(dir, "valid.jsonl"), goodLines);
  await Bun.write(join(dir, "bad.jsonl"), goodLines + invalid + goodLines);
  expect((await journal.read("valid", 0)).next).toBe(3);
  expect(await journal.reply("valid", "r1")).toBe("OK");
  expect(await journal.history("valid")).toEqual([
    { role: "user", text: "Build it", at: 1 },
    { role: "assistant", text: "OK", at: 2 },
  ]);
  await expectJournalReadError(journal.read("bad", 100), diagnostic);
  await expectJournalReadError(journal.reply("bad", "r1"), diagnostic);
  await expectJournalReadError(journal.history("bad"), diagnostic);
  await expectJournalReadError(journal.append("bad", settled), diagnostic);
});

test("consumers reject a complete final record without a newline", async () => {
  const { dir, journal } = await fixture();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lastRecord: JournalRecord = { t: "note", text: "last", at: 6 };
  await Bun.write(join(dir, "valid.jsonl"), goodLines + JSON.stringify(lastRecord) + "\n");
  await Bun.write(join(dir, "incomplete.jsonl"), goodLines + JSON.stringify(lastRecord) + " ");

  expect(await journal.read("valid", 0)).toEqual({ records: [submitted, chunk("r1", "OK", 2), settled, lastRecord], next: 4 });
  expect(await journal.reply("valid", "r1")).toBe("OK");
  expect(await journal.history("valid")).toEqual([
    { role: "user", text: "Build it", at: 1 },
    { role: "assistant", text: "OK", at: 2 },
  ]);
  expect(await journal.append("valid", lastRecord)).toBe(5);

  await expectJournalReadError(journal.read("incomplete", 0), "Incomplete journal");
  await expectJournalReadError(journal.reply("incomplete", "r1"), "Incomplete journal");
  await expectJournalReadError(journal.history("incomplete"), "Incomplete journal");
  await expectJournalReadError(journal.append("incomplete", lastRecord), "Incomplete journal");
});

test("truncated final records and unreadable paths fail through each reader", async () => {
  const { dir, journal } = await fixture();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Bun.write(join(dir, "truncated.jsonl"), goodLines + '{"t":"note"');
  await mkdir(join(dir, "unreadable.jsonl"));
  for (const [session, diagnostic] of [["truncated", "Incomplete journal"], ["unreadable", "Cannot read journal"]]) {
    await expectJournalReadError(journal.read(session, 0), diagnostic);
    await expectJournalReadError(journal.reply(session, "r1"), diagnostic);
    await expectJournalReadError(journal.history(session), diagnostic);
  }
});
