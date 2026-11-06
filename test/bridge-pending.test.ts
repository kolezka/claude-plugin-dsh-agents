import { expect, test } from "bun:test";
import { PendingError, PendingQueue } from "../src/bridge/pending";

const options = [
  { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
  { optionId: "reject-once", kind: "reject_once", name: "Reject once" },
];

test("pending items are unique, timestamped and listed only in their own session", () => {
  const pending = new PendingQueue();
  const changes: string[] = [];
  const unsubscribe = pending.onChange((session) => changes.push(session));
  const question = pending.addQuestion("s1", "Continue?", ["yes", "no"]);
  const permission = pending.addPermission("s2", "call-1", options, "missing");
  expect(question.requestId).not.toBe(permission.requestId);
  expect(question).toMatchObject({ kind: "question", session: "s1", question: "Continue?", choices: ["yes", "no"] });
  expect(question.createdAt).toBeGreaterThan(0);
  expect(pending.list("s1")).toEqual([question]);
  expect(pending.list("s2")).toEqual([permission]);
  expect(changes).toEqual(["s1", "s2"]);
  unsubscribe();
  pending.addQuestion("s1", "Another?");
  expect(changes).toEqual(["s1", "s2"]);
});

test("an answer is buffered or delivered to a waiter exactly once", async () => {
  const pending = new PendingQueue();
  const first = pending.addQuestion("s1", "First?");
  pending.answer(first.requestId, { text: "yes" });
  expect(pending.list("s1")).toEqual([]);
  expect(() => pending.answer(first.requestId, { text: "again" })).toThrow("answered");
  expect(await pending.waitFor(first.requestId, 100)).toEqual({ text: "yes" });
  await expect(pending.waitFor(first.requestId, 100)).rejects.toThrow("unknown");
  expect(() => pending.answer(first.requestId, { text: "again" })).toThrow("answered");
  expect(() => pending.answer("missing", { text: "no" })).toThrow("unknown");
  const second = pending.addQuestion("s1", "Second?");
  const waiting = pending.waitFor(second.requestId, 100);
  pending.answer(second.requestId, { text: "now" });
  expect(await waiting).toEqual({ text: "now" });
});

test.each([
  { label: "without choices", choices: undefined, text: "pineapple" },
  { label: "matching proposed choices", choices: ["pineapple", "pear"], text: "pineapple" },
  { label: "outside proposed choices", choices: ["pineapple", "pear"], text: "plum instead" },
  { label: "with empty proposed choices", choices: [], text: "any answer" },
].flatMap((scenario) => [false, true].map((active) => ({
  ...scenario, active, delivery: active ? "active waiter" : "buffered",
}))))("question text answers work $label with $delivery delivery", async ({ choices, text, active }) => {
  const pending = new PendingQueue();
  const question = pending.addQuestion("s1", "Which fruit?", choices);
  const waiting = active ? pending.waitFor(question.requestId, 100) : undefined;
  pending.answer(question.requestId, { text });
  expect(await (waiting ?? pending.waitFor(question.requestId, 100))).toEqual({ text });
  expect(pending.list("s1")).toEqual([]);
  await expect(pending.waitFor(question.requestId, 100)).rejects.toThrow("unknown");
});

test("permission answers require a valid option choice and reject text without consuming the item", async () => {
  const pending = new PendingQueue();
  const permission = pending.addPermission("s1", "call-1", options, { title: "Shell", rawInput: { command: "pwd" } });
  for (const answer of [
    { text: "allow-once" },
    { choice: "other" },
    { text: "x", choice: "allow-once" },
  ] as const) {
    expect(() => pending.answer(permission.requestId, answer)).toThrow("invalid");
    expect(pending.list("s1")).toEqual([permission]);
  }
  pending.answer(permission.requestId, { choice: "allow-once" });
  expect(await pending.waitFor(permission.requestId, 100)).toEqual({ choice: "allow-once" });
});

test("timeout and abort detach waits without discarding the question or its answer", async () => {
  const pending = new PendingQueue();
  const question = pending.addQuestion("s1", "Keep?");
  expect(await pending.waitFor(question.requestId, 1)).toBe("timeout");
  const controller = new AbortController();
  const waiting = pending.waitFor(question.requestId, 100, controller.signal);
  const aborted = waiting.catch((error: Error) => error);
  controller.abort();
  expect(await aborted).toMatchObject({ name: "AbortError" });
  expect(pending.list("s1")).toEqual([question]);
  pending.answer(question.requestId, { text: "saved" });
  await expect(pending.waitFor(question.requestId, 100, controller.signal)).rejects.toThrow();
  expect(await pending.waitFor(question.requestId, 100)).toEqual({ text: "saved" });
});

test("simultaneous waiters cannot duplicate delivery", async () => {
  const pending = new PendingQueue();
  const question = pending.addQuestion("s1", "One consumer?");
  const first = pending.waitFor(question.requestId, 100);
  await expect(pending.waitFor(question.requestId, 100)).rejects.toThrow();
  pending.answer(question.requestId, { text: "one" });
  expect(await first).toEqual({ text: "one" });
});

test("cancelSession resolves active and future waits only for that session", async () => {
  const pending = new PendingQueue();
  const question = pending.addQuestion("s1", "Cancel?");
  const permission = pending.addPermission("s1", "call-1", options, "missing");
  const other = pending.addQuestion("s2", "Keep?");
  const waiting = pending.waitFor(question.requestId, 100);
  pending.cancelSession("s1");
  expect(await waiting).toEqual({ cancelled: true });
  expect(await pending.waitFor(permission.requestId, 100)).toEqual({ cancelled: true });
  expect(pending.list("s1")).toEqual([]);
  expect(pending.list("s2")).toEqual([other]);
});

test("resume invalidation drops stale answers and settles open waits without delivery", async () => {
  const pending = new PendingQueue();
  const question = pending.addQuestion("s1", "Old?");
  const buffered = pending.addQuestion("s1", "Buffered?");
  const other = pending.addQuestion("s2", "Keep?");
  pending.answer(buffered.requestId, { text: "stale" });
  const waiting = pending.waitFor(question.requestId, 100);
  const invalidated = waiting.catch((error: Error) => error);
  pending.invalidateSession("s1");
  expect(await invalidated).toBeInstanceOf(PendingError);
  expect((await invalidated as Error).message).toBe("unknown");
  expect(pending.list("s1")).toEqual([]);
  expect(pending.list("s2")).toEqual([other]);
  await expect(pending.waitFor(buffered.requestId, 100)).rejects.toThrow("unknown");
});

test("callers cannot mutate stored items, option lists or buffered answers", async () => {
  const pending = new PendingQueue();
  const choices = ["yes", "no"];
  const question = pending.addQuestion("s1", "Choose?", choices);
  const permissionOptions = structuredClone(options);
  const permission = pending.addPermission("s1", "call-1", permissionOptions, "missing");
  choices.push("injected");
  permissionOptions.push({ optionId: "injected", kind: "allow_once", name: "Injected" });
  const [listedQuestion, listedPermission] = pending.list("s1");
  if (listedQuestion?.kind === "question") listedQuestion.choices?.push("mutated");
  if (listedPermission?.kind === "permission") {
    listedPermission.options.push({ optionId: "mutated", kind: "allow_once", name: "Mutated" });
  }
  expect(pending.list("s1")).toEqual([question, permission]);
  expect(() => pending.answer(permission.requestId, { choice: "injected" })).toThrow("invalid");
  expect(() => pending.answer(permission.requestId, { choice: "mutated" })).toThrow("invalid");
  const answer = { text: "yes" };
  pending.answer(question.requestId, answer);
  answer.text = "no";
  expect(await pending.waitFor(question.requestId, 100)).toEqual({ text: "yes" });
});
