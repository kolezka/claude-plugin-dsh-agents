export const MAX_FRAME_BYTES = 1_048_576;

export type HelloFrame = { hello: 1; token: string };
export type RequestFrame = {
  id: string;
  tool: "ask_lead" | "wait_lead" | "notify_lead";
  args: Record<string, unknown>;
};
export type CancelFrame = { id: string; cancel: true };
export type ReplyFrame = { id: string; result: unknown } | { id: string; error: string };

export class FrameTooLarge extends Error {
  constructor() { super("frame exceeds byte limit"); }
}

export class FrameShapeError extends Error {
  constructor() { super("invalid frame shape"); }
}

export class FrameDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(start, index));
      const bytes = Buffer.concat(this.parts, this.size);
      this.parts = [];
      this.size = 0;
      frames.push(JSON.parse(this.decoder.decode(bytes)));
      start = index + 1;
    }
    this.append(chunk.subarray(start));
    return frames;
  }

  private append(bytes: Uint8Array) {
    if (this.size + bytes.length > MAX_FRAME_BYTES) throw new FrameTooLarge();
    if (bytes.length) this.parts.push(Buffer.from(bytes));
    this.size += bytes.length;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseInbound(value: unknown): HelloFrame | RequestFrame | CancelFrame {
  if (!record(value)) throw new FrameShapeError();
  const keys = Object.keys(value);
  if (keys.length === 2 && value.hello === 1 && nonempty(value.token)) {
    return { hello: 1, token: value.token };
  }
  if (keys.length === 2 && nonempty(value.id) && value.cancel === true) {
    return { id: value.id, cancel: true };
  }
  if (keys.length === 3 && nonempty(value.id) && record(value.args)
    && (value.tool === "ask_lead" || value.tool === "wait_lead" || value.tool === "notify_lead")) {
    return { id: value.id, tool: value.tool, args: value.args };
  }
  throw new FrameShapeError();
}

export function encodeFrame(frame: object): Uint8Array {
  const json = JSON.stringify(frame);
  if (json === undefined) throw new FrameShapeError();
  if (Buffer.byteLength(json) > MAX_FRAME_BYTES) throw new FrameTooLarge();
  return new TextEncoder().encode(json + "\n");
}
