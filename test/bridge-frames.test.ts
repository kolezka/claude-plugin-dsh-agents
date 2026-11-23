import { expect, test } from "bun:test";
import {
  encodeFrame, FrameDecoder, FrameShapeError, FrameTooLarge, MAX_FRAME_BYTES, parseInbound,
} from "../src/bridge/frames";

const bytes = (text: string) => new TextEncoder().encode(text);

test("decoder reassembles split frames and splits coalesced ones", () => {
  const decoder = new FrameDecoder();
  expect(decoder.push(bytes('{"a":1}\n{"b":'))).toEqual([{ a: 1 }]);
  expect(decoder.push(bytes('2}\n'))).toEqual([{ b: 2 }]);
});

test("decoder decodes a multibyte character split across chunks", () => {
  const frame = bytes('{"q":"ż🙂"}\n');
  for (let split = 1; split < frame.length; split++) {
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.slice(0, split))).toEqual([]);
    expect(decoder.push(frame.slice(split))).toEqual([{ q: "ż🙂" }]);
  }
});

test("frame size is enforced per frame in bytes, not per chunk or character", () => {
  expect(() => new FrameDecoder().push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(97)))
    .toThrow(FrameTooLarge);
  const decoder = new FrameDecoder();
  decoder.push(bytes('"' + "a".repeat(MAX_FRAME_BYTES - 2)));
  expect(decoder.push(bytes('"\n'))).toEqual(["a".repeat(MAX_FRAME_BYTES - 2)]);
  const oversized = new FrameDecoder();
  oversized.push(bytes('"' + "ż".repeat(MAX_FRAME_BYTES / 2 - 1)));
  expect(() => oversized.push(bytes('ż"\n'))).toThrow(FrameTooLarge);
  const coalesced = bytes(('"' + "a".repeat(MAX_FRAME_BYTES - 2) + '"\n').repeat(2));
  expect(new FrameDecoder().push(coalesced)).toHaveLength(2);
});

test("decoder rejects malformed JSON and invalid UTF-8", () => {
  expect(() => new FrameDecoder().push(bytes('{oops}\n'))).toThrow();
  expect(() => new FrameDecoder().push(new Uint8Array([34, 255, 34, 10]))).toThrow();
});

test("parseInbound accepts hello, request and cancellation frames", () => {
  expect(parseInbound({ hello: 1, token: "secret" })).toEqual({ hello: 1, token: "secret" });
  expect(parseInbound({ id: "1", cancel: true })).toEqual({ id: "1", cancel: true });
  for (const tool of ["ask_lead", "wait_lead", "notify_lead"] as const) {
    expect(parseInbound({ id: "1", tool, args: {} })).toEqual({ id: "1", tool, args: {} });
  }
});

test.each([
  null, [], true, "text", {}, { id: "1" }, { hello: 1 }, { hello: 2, token: "x" },
  { hello: 1, token: "" }, { id: "", cancel: true }, { id: "1", cancel: false },
  { id: "1", tool: "other", args: {} }, { id: "1", tool: "ask_lead", args: [] },
  { id: "1", tool: "ask_lead", args: null }, { id: 1, cancel: true },
  { hello: 1, token: "x", id: "1", cancel: true },
  { id: "1", cancel: true, tool: "ask_lead", args: {} },
].map((frame) => ({ frame })))("parseInbound rejects invalid or ambiguous shape %j", ({ frame }) => {
  expect(() => parseInbound(frame)).toThrow(FrameShapeError);
});

test("encodeFrame produces one UTF-8 NDJSON frame and enforces the byte limit", () => {
  expect(new TextDecoder().decode(encodeFrame({ text: "ż\n🙂" })))
    .toBe('{"text":"ż\\n🙂"}\n');
  expect(() => encodeFrame({ text: "a".repeat(MAX_FRAME_BYTES) })).toThrow(FrameTooLarge);
});
